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
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(Error::Codec(
            "direct-sync frame exceeds 16 MiB; use the relay for this backlog".into(),
        ));
    }
    stream
        .write_all(&(bytes.len() as u32).to_be_bytes())
        .map_err(io)?;
    stream.write_all(bytes).map_err(io)?;
    stream.flush().map_err(io)?;
    Ok(())
}

fn read_frame(stream: &mut TcpStream) -> Result<Vec<u8>> {
    let mut len = [0u8; 4];
    stream.read_exact(&mut len).map_err(io)?;
    let length = u32::from_be_bytes(len) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(Error::Codec(
            "direct-sync frame exceeds the 16 MiB safety limit".into(),
        ));
    }
    let mut buf = vec![0u8; length];
    stream.read_exact(&mut buf).map_err(io)?;
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
    let plaintext = zstd::stream::decode_all(Cursor::new(compressed))
        .map_err(|error| Error::Codec(format!("decompression: {error}")))?;
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
}
