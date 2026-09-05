//! Peer-to-peer transport: two devices reconcile their operation logs directly
//! over a TCP socket (pairs with mDNS discovery on a LAN). Every frame is a
//! `SyncKey`-sealed JSON [`Message`], so an observer sees only ciphertext.
//!
//! Protocol (three frames, one round trip each way):
//!
//! ```text
//! initiator                                   responder
//!   Offer { v, inventory }      ------------>
//!                               <------------  Diff { ops, want }
//!   Ops { ops }                 ------------>
//! ```
//!
//! The ordering is the whole point. Each side does its expensive work — merging
//! and rematerializing the log — only *after* its last network obligation, so
//! neither peer can be left blocking on a socket while the other rebuilds its
//! database. The responder's only work between receiving and replying is a
//! bounded id-set diff.
//!
//! Every database touch goes through [`SyncStore`], whose implementations take
//! the app's global database guard for the duration of that call and release it
//! before returning. No guard and no connection is ever held across socket I/O,
//! so two devices can sync at each other simultaneously without deadlocking.

use std::io::{Cursor, ErrorKind, Read, Write};
use std::net::{TcpListener, TcpStream, ToSocketAddrs};
use std::time::Duration;

use serde::{Deserialize, Serialize};

use super::crypto::SyncKey;
use super::{Error, Op, Result, SyncInventory, SyncStore, PROTOCOL_VERSION};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);
const IO_TIMEOUT: Duration = Duration::from_secs(60);
const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
const CONTINUATION: u32 = 1 << 31;
const MAX_MESSAGE_BYTES: usize = 512 * 1024 * 1024;

pub(crate) const TIMEOUT_MESSAGE: &str =
    "timed out waiting for the other device — is Balance open there?";
const VERSION_MESSAGE: &str =
    "the other device is running an incompatible Balance version — update both devices";

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t")]
pub enum Message {
    /// Initiator's current post-checkpoint operation inventory and frontiers.
    Offer { v: u32, inventory: SyncInventory },
    /// Responder's answer: ops the initiator lacks, plus ids it wants back.
    Diff { ops: Vec<Op>, want: Vec<String> },
    /// Initiator's reply with the ops the responder asked for.
    Ops { ops: Vec<Op> },
}

fn io(e: std::io::Error) -> Error {
    match e.kind() {
        // A 60s read/write deadline surfaces as TimedOut (or EAGAIN/WouldBlock
        // on Android). "os error 11" tells a user nothing; this does.
        ErrorKind::TimedOut | ErrorKind::WouldBlock => Error::Codec(TIMEOUT_MESSAGE.to_string()),
        _ => Error::Codec(format!("io: {e}")),
    }
}

fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> Result<()> {
    if bytes.len() > MAX_MESSAGE_BYTES {
        return Err(Error::Codec(
            "direct-sync message exceeds the 512 MiB safety limit".into(),
        ));
    }
    // Preserve the original single-frame wire format for ordinary exchanges.
    // Large encrypted envelopes travel in bounded continuation frames. The
    // AEAD authenticates the complete envelope before any operations are used.
    for (index, chunk) in bytes.chunks(MAX_FRAME_BYTES).enumerate() {
        let more = (index + 1) * MAX_FRAME_BYTES < bytes.len();
        let length = chunk.len() as u32 | if more { CONTINUATION } else { 0 };
        stream.write_all(&length.to_be_bytes()).map_err(io)?;
        stream.write_all(chunk).map_err(io)?;
    }
    stream.flush().map_err(io)?;
    Ok(())
}

fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut buf = Vec::new();
    loop {
        let mut len = [0u8; 4];
        stream.read_exact(&mut len).map_err(io)?;
        let header = u32::from_be_bytes(len);
        let length = (header & !CONTINUATION) as usize;
        if length == 0
            || length > MAX_FRAME_BYTES
            || buf.len().saturating_add(length) > MAX_MESSAGE_BYTES
        {
            return Err(Error::Codec(
                "invalid or oversized direct-sync frame; update both devices if necessary".into(),
            ));
        }
        let start = buf.len();
        buf.resize(start + length, 0);
        stream.read_exact(&mut buf[start..]).map_err(io)?;
        if header & CONTINUATION == 0 {
            break;
        }
    }
    Ok(buf)
}

fn configure_stream(stream: &TcpStream) -> Result<()> {
    configure_stream_with_timeout(stream, IO_TIMEOUT)
}

fn configure_stream_with_timeout(stream: &TcpStream, timeout: Duration) -> Result<()> {
    stream.set_read_timeout(Some(timeout)).map_err(io)?;
    stream.set_write_timeout(Some(timeout)).map_err(io)?;
    Ok(())
}

fn connect(addr: &str) -> Result<TcpStream> {
    let addresses = addr.to_socket_addrs().map_err(io)?;
    let mut last_error = None;

    for address in addresses {
        match TcpStream::connect_timeout(&address, CONNECT_TIMEOUT) {
            Ok(stream) => {
                configure_stream(&stream)?;
                return Ok(stream);
            }
            Err(error) => last_error = Some(error),
        }
    }

    Err(last_error
        .map(io)
        .unwrap_or_else(|| Error::Codec(format!("io: no socket addresses resolved for {addr}"))))
}

fn send(stream: &mut TcpStream, key: &SyncKey, message: &Message) -> Result<()> {
    let plaintext = serde_json::to_vec(message).map_err(|e| Error::Codec(e.to_string()))?;
    let compressed = zstd::stream::encode_all(Cursor::new(plaintext), 3)
        .map_err(|error| Error::Codec(format!("compression: {error}")))?;
    write_frame(stream, &key.seal(&compressed)?)
}

fn recv(stream: &mut TcpStream, key: &SyncKey) -> Result<Message> {
    let sealed = read_frame(stream)?;
    let compressed = key.open(&sealed)?;
    let decoder = zstd::stream::read::Decoder::new(Cursor::new(compressed))
        .map_err(|error| Error::Codec(format!("decompression: {error}")))?;
    let mut plaintext = Vec::new();
    decoder
        .take(MAX_MESSAGE_BYTES as u64 + 1)
        .read_to_end(&mut plaintext)
        .map_err(io)?;
    if plaintext.len() > MAX_MESSAGE_BYTES {
        return Err(Error::Codec(
            "decoded direct-sync message exceeds the safety limit".into(),
        ));
    }
    serde_json::from_slice(&plaintext).map_err(|e| Error::Codec(e.to_string()))
}

/// Initiator half of a one-shot bidirectional sync.
pub fn run_initiator(stream: &mut TcpStream, key: &SyncKey, store: &dyn SyncStore) -> Result<()> {
    let inventory = store.inventory()?;
    send(
        stream,
        key,
        &Message::Offer {
            v: PROTOCOL_VERSION,
            inventory,
        },
    )?;

    let (ops, want) = match recv(stream, key)? {
        Message::Diff { ops, want } => (ops, want),
        _ => return Err(Error::Codec("unexpected reply to sync offer".into())),
    };

    // Answer the peer *before* merging: everything below is local-only work.
    let requested = store.ops_by_id(&want)?;
    send(stream, key, &Message::Ops { ops: requested })?;

    store.merge(ops)?;
    Ok(())
}

/// Responder half of a one-shot bidirectional sync.
pub fn run_responder(stream: &mut TcpStream, key: &SyncKey, store: &dyn SyncStore) -> Result<()> {
    let inventory = match recv(stream, key)? {
        Message::Offer { v, inventory } => {
            if v != PROTOCOL_VERSION {
                return Err(Error::Codec(VERSION_MESSAGE.to_string()));
            }
            inventory
        }
        _ => return Err(Error::Codec("expected a sync offer".into())),
    };

    // Bounded id-set diff only — no rematerialization before the reply.
    let (ops, want) = store.diff(&inventory)?;
    send(stream, key, &Message::Diff { ops, want })?;

    let received = match recv(stream, key)? {
        Message::Ops { ops } => ops,
        _ => return Err(Error::Codec("unexpected reply to sync diff".into())),
    };

    store.merge(received)?;
    Ok(())
}

/// Initiator entry point: dial `addr` and run the exchange.
pub fn sync_connect(addr: &str, key: &SyncKey, store: &dyn SyncStore) -> Result<()> {
    let mut stream = connect(addr)?;
    run_initiator(&mut stream, key, store)
}

/// Responder entry point that owns the accept.
pub fn sync_accept(listener: &TcpListener, key: &SyncKey, store: &dyn SyncStore) -> Result<()> {
    let (stream, _) = listener.accept().map_err(io)?;
    sync_accept_stream(stream, key, store)
}

/// Responder flow for an already-accepted socket. The background P2P listener
/// accepts before touching the database, so it never pins an obsolete database
/// file while idle or during atomic maintenance.
pub fn sync_accept_stream(
    mut stream: TcpStream,
    key: &SyncKey,
    store: &dyn SyncStore,
) -> Result<()> {
    configure_stream(&stream)?;
    run_responder(&mut stream, key, store)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Instant;

    #[test]
    fn large_encrypted_envelopes_cross_multiple_bounded_frames() {
        use rand::RngCore;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let mut bytes = vec![0u8; MAX_FRAME_BYTES + 4096];
        rand::thread_rng().fill_bytes(&mut bytes);
        let key = SyncKey::generate();
        let sealed = key.seal(&bytes).unwrap();
        let sender = std::thread::spawn(move || {
            let mut stream = TcpStream::connect(address).unwrap();
            write_frame(&mut stream, &sealed).unwrap();
        });
        let (mut stream, _) = listener.accept().unwrap();
        let received = read_frame(&mut stream).unwrap();
        assert_eq!(key.open(&received).unwrap(), bytes);
        sender.join().unwrap();
    }

    #[test]
    fn oversized_continuation_frames_are_rejected_before_allocation() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let mut peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        peer.write_all(&((MAX_FRAME_BYTES as u32 + 1) | CONTINUATION).to_be_bytes())
            .unwrap();
        assert!(read_frame(&mut stream)
            .unwrap_err()
            .to_string()
            .contains("oversized"));
    }

    #[test]
    fn stalled_socket_read_reports_a_human_timeout_message() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let peer = TcpStream::connect(listener.local_addr().unwrap()).unwrap();
        let (mut stream, _) = listener.accept().unwrap();
        let timeout = Duration::from_millis(50);
        configure_stream_with_timeout(&stream, timeout).unwrap();

        assert_eq!(stream.read_timeout().unwrap(), Some(timeout));
        assert_eq!(stream.write_timeout().unwrap(), Some(timeout));

        let started = Instant::now();
        let error = read_frame(&mut stream).unwrap_err();
        assert!(started.elapsed() < Duration::from_secs(2));
        assert_eq!(error.to_string(), format!("codec: {TIMEOUT_MESSAGE}"));
        assert!(
            !error.to_string().contains("os error"),
            "raw errno must not reach the user: {error}"
        );

        drop(peer);
    }

    #[test]
    fn direct_sync_initiator_success_does_not_acknowledge_responder_merge() {
        use std::sync::Mutex;

        struct SyntheticStore {
            ops: Mutex<Vec<Op>>,
            fail_merge: bool,
            merge_delay: Duration,
        }
        impl SyncStore for SyntheticStore {
            fn inventory(&self) -> Result<SyncInventory> {
                Ok(SyncInventory {
                    items: self
                        .ops
                        .lock()
                        .unwrap()
                        .iter()
                        .map(|op| super::super::InventoryItem {
                            id: op.id.clone(),
                            device_id: op.device_id.clone(),
                            sequence: op.sequence,
                            checkpoint: false,
                        })
                        .collect(),
                    frontiers: Default::default(),
                })
            }
            fn diff(&self, peer: &SyncInventory) -> Result<(Vec<Op>, Vec<String>)> {
                let ops = self.ops.lock().unwrap();
                Ok((
                    ops.iter()
                        .filter(|op| !peer.items.iter().any(|item| item.id == op.id))
                        .cloned()
                        .collect(),
                    peer.items
                        .iter()
                        .filter(|item| !ops.iter().any(|op| op.id == item.id))
                        .map(|item| item.id.clone())
                        .collect(),
                ))
            }
            fn ops_by_id(&self, ids: &[String]) -> Result<Vec<Op>> {
                Ok(self
                    .ops
                    .lock()
                    .unwrap()
                    .iter()
                    .filter(|op| ids.contains(&op.id))
                    .cloned()
                    .collect())
            }
            fn merge(&self, incoming: Vec<Op>) -> Result<usize> {
                std::thread::sleep(self.merge_delay);
                if self.fail_merge {
                    assert_eq!(
                        incoming.len(),
                        1,
                        "the encrypted completion reached the responder"
                    );
                    assert_eq!(incoming[0].id, "phone-completion");
                    return Err(Error::Codec("synthetic receiver transaction failed".into()));
                }
                let mut ops = self.ops.lock().unwrap();
                let before = ops.len();
                for op in incoming {
                    if !ops.iter().any(|existing| existing.id == op.id) {
                        ops.push(op);
                    }
                }
                Ok(ops.len() - before)
            }
        }
        let operation = |id: &str, device: &str| Op {
            id: id.into(),
            device_id: device.into(),
            sequence: 1,
            op_type: "patch_plan_item".into(),
            timestamp: "2026-09-05T12:00:00.000Z".into(),
            payload_json:
                r#"{"planId":"synthetic-plan","itemId":"synthetic-task","patch":{"done":true}}"#
                    .into(),
        };
        for (initiator_delay, responder_delay) in [(0, 0), (20, 0), (0, 20), (5, 30)] {
            let initiator = SyntheticStore {
                ops: Mutex::new(vec![operation("phone-completion", "phone")]),
                fail_merge: false,
                merge_delay: Duration::from_millis(initiator_delay),
            };
            let responder = SyntheticStore {
                ops: Mutex::new(vec![operation("desktop-completion", "desktop")]),
                fail_merge: true,
                merge_delay: Duration::from_millis(responder_delay),
            };
            let key = SyncKey::generate();
            for attempt in 0..3 {
                let listener = TcpListener::bind("127.0.0.1:0").unwrap();
                let address = listener.local_addr().unwrap().to_string();
                std::thread::scope(|scope| {
                    let receiver = scope.spawn(|| sync_accept(&listener, &key, &responder));
                    let sent = sync_connect(&address, &key, &initiator);
                    assert!(
                        sent.is_ok(),
                        "attempt {attempt}, delays {initiator_delay}/{responder_delay}: {sent:?}"
                    );
                    let error = receiver.join().unwrap().unwrap_err();
                    assert!(error
                        .to_string()
                        .contains("synthetic receiver transaction failed"));
                });
                assert_eq!(
                    initiator.ops.lock().unwrap().len(),
                    2,
                    "initiator successfully receives the peer's operation"
                );
                assert_eq!(
                    responder.ops.lock().unwrap().len(),
                    1,
                    "receiver remains missing the phone completion after repeated sender success"
                );
            }
        }
        // Characterizes protocol v3's three-frame limitation. A sender success
        // confirms its own merge, but there is no durable receiver acknowledgement.
    }
}
