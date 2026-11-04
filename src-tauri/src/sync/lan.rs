//! Direct sync between paired devices on the same local network.
//!
//! Every connection starts with a `Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s`
//! handshake whose pre-shared key is derived from the pairing secret. Only a
//! device holding that secret can complete it, each session gets fresh
//! ephemeral keys (forward secrecy), and the transport's counter nonces reject
//! replayed, reordered or altered frames. Nothing but the two 48-byte handshake
//! messages is read from an unauthenticated peer.
//!
//! After the handshake, one exchange is four messages:
//!
//! ```text
//! initiator                                   responder
//!   Offer { v, inventory }      ------------>
//!                               <------------  Diff { ops, want }
//!   Ops { ops }                 ------------>
//!                               <------------  Merged { inserted }
//! ```
//!
//! Each side reads and diffs between socket operations, but merges only after
//! it has sent everything the peer is waiting for, except the responder's final
//! acknowledgement, which reports whether its merge actually committed. Every
//! database touch goes through [`SyncStore`], whose app implementation takes
//! the global database guard per call, so no lock is held across socket I/O.
//!
//! Discovery advertises only a random per-launch salt and a truncated HMAC of
//! it, so devices recognize their own peers without broadcasting a stable
//! identifier.

use std::io::{Cursor, ErrorKind, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::{Duration, Instant};

use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use snow::{Builder, HandshakeState, TransportState};
use zeroize::Zeroizing;

use super::crypto::SyncKey;
use super::{Error, Op, Result, SyncInventory, SyncStore, PROTOCOL_VERSION};

const NOISE_PATTERN: &str = "Noise_NNpsk0_25519_ChaChaPoly_BLAKE2s";
const PROLOGUE: &[u8] = b"balance-lan-sync/1";
const NOISE_MAX_FRAME: usize = 65_535;
const NOISE_TAG: usize = 16;
const CHUNK: usize = NOISE_MAX_FRAME - NOISE_TAG;
// Both handshake messages are an ephemeral key plus an empty sealed payload.
const MAX_HANDSHAKE_FRAME: usize = 128;
const MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;
const MAX_PLAINTEXT_BYTES: u64 = 256 * 1024 * 1024;
const TAG_BYTES: usize = 16;

pub const CONNECT_TIMEOUT: Duration = Duration::from_millis(1_500);
pub const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(3);
const IO_TIMEOUT: Duration = Duration::from_secs(60);

pub(crate) const TIMEOUT_MESSAGE: &str =
    "timed out waiting for the other device — is Balance open there?";
pub(crate) const VERSION_MESSAGE: &str =
    "the other device is running an incompatible Balance version — update both devices";

/// Keys derived from the pairing secret, separate from the relay's envelope
/// key so the two protocols never share key material.
pub struct LanKeys {
    psk: Zeroizing<[u8; 32]>,
    discovery: Zeroizing<[u8; 32]>,
}

impl LanKeys {
    pub fn derive(key: &SyncKey) -> Self {
        let hkdf = Hkdf::<Sha256>::new(Some(b"balance-lan-sync"), key.as_bytes());
        let mut psk = Zeroizing::new([0u8; 32]);
        let mut discovery = Zeroizing::new([0u8; 32]);
        hkdf.expand(b"noise psk v1", psk.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 length");
        hkdf.expand(b"discovery tag v1", discovery.as_mut())
            .expect("32 bytes is a valid HKDF-SHA256 length");
        LanKeys { psk, discovery }
    }

    fn tag_mac(&self, salt: &str) -> Hmac<Sha256> {
        let mut mac = Hmac::<Sha256>::new_from_slice(self.discovery.as_ref())
            .expect("HMAC accepts any key length");
        mac.update(salt.as_bytes());
        mac
    }

    /// The discovery tag advertised next to `salt`.
    pub fn discovery_tag(&self, salt: &str) -> String {
        super::hex(&self.tag_mac(salt).finalize().into_bytes()[..TAG_BYTES])
    }

    /// Whether an advertised `(salt, tag)` belongs to a device with this key.
    pub fn recognizes(&self, salt: &str, tag: &str) -> bool {
        let Some(tag) = decode_hex(tag).filter(|tag| tag.len() == TAG_BYTES) else {
            return false;
        };
        self.tag_mac(salt).verify_truncated_left(&tag).is_ok()
    }

    fn builder(&self) -> Result<Builder<'_>> {
        let params = NOISE_PATTERN.parse().map_err(noise)?;
        Builder::new(params)
            .prologue(PROLOGUE)
            .and_then(|builder| builder.psk(0, &self.psk))
            .map_err(noise)
    }
}

fn decode_hex(value: &str) -> Option<Vec<u8>> {
    if value.len() % 2 != 0 {
        return None;
    }
    (0..value.len())
        .step_by(2)
        .map(|index| u8::from_str_radix(value.get(index..index + 2)?, 16).ok())
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(tag = "t")]
enum Message {
    /// Initiator's current post-checkpoint inventory and frontiers.
    Offer { v: u32, inventory: SyncInventory },
    /// Responder's answer: ops the initiator lacks, plus ids it wants back.
    Diff { ops: Vec<Op>, want: Vec<String> },
    /// Responder runs a different protocol version and will not exchange ops.
    Incompatible { v: u32 },
    /// Initiator's reply with the ops the responder asked for.
    Ops { ops: Vec<Op> },
    /// Responder committed its merge.
    Merged { inserted: usize },
    /// Responder could not apply what it received.
    MergeFailed { error: String },
}

/// What one exchange changed on each side.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub struct Outcome {
    /// Operations this device inserted.
    pub received: usize,
    /// Operations the other device acknowledged inserting.
    pub delivered: usize,
}

fn noise(error: snow::Error) -> Error {
    Error::Crypto(format!("local sync handshake: {error}"))
}

fn io(error: std::io::Error) -> Error {
    match error.kind() {
        // Android surfaces deadlines as EAGAIN/WouldBlock; "os error 11" tells
        // a user nothing.
        ErrorKind::TimedOut | ErrorKind::WouldBlock => Error::Codec(TIMEOUT_MESSAGE.into()),
        _ => Error::Codec(format!("local sync connection: {error}")),
    }
}

fn write_frame(stream: &mut impl Write, frame: &[u8]) -> Result<()> {
    debug_assert!(frame.len() <= NOISE_MAX_FRAME);
    stream
        .write_all(&(frame.len() as u16).to_be_bytes())
        .map_err(io)?;
    stream.write_all(frame).map_err(io)?;
    stream.flush().map_err(io)
}

fn read_frame(stream: &mut impl Read) -> Result<Vec<u8>> {
    let mut length = [0u8; 2];
    stream.read_exact(&mut length).map_err(io)?;
    let mut frame = vec![0u8; u16::from_be_bytes(length) as usize];
    stream.read_exact(&mut frame).map_err(io)?;
    Ok(frame)
}

/// Fill `buffer` before `deadline`. A socket timeout restarts on every byte, so
/// on its own it would let an unauthenticated peer dribble a connection open.
fn read_until(stream: &mut TcpStream, buffer: &mut [u8], deadline: Instant) -> Result<()> {
    let mut filled = 0;
    while filled < buffer.len() {
        let remaining = deadline.saturating_duration_since(Instant::now());
        if remaining.is_zero() {
            return Err(Error::Codec(TIMEOUT_MESSAGE.into()));
        }
        stream.set_read_timeout(Some(remaining)).map_err(io)?;
        match stream.read(&mut buffer[filled..]) {
            Ok(0) => return Err(io(ErrorKind::UnexpectedEof.into())),
            Ok(read) => filled += read,
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => return Err(io(error)),
        }
    }
    Ok(())
}

fn read_handshake_frame(stream: &mut TcpStream, deadline: Instant) -> Result<Vec<u8>> {
    let mut length = [0u8; 2];
    read_until(stream, &mut length, deadline)?;
    let length = u16::from_be_bytes(length) as usize;
    if length > MAX_HANDSHAKE_FRAME {
        return Err(Error::Crypto("local sync handshake is larger than allowed".into()));
    }
    let mut frame = vec![0u8; length];
    read_until(stream, &mut frame, deadline)?;
    Ok(frame)
}

fn set_timeout(stream: &TcpStream, timeout: Duration) -> Result<()> {
    stream.set_read_timeout(Some(timeout)).map_err(io)?;
    stream.set_write_timeout(Some(timeout)).map_err(io)
}

/// An authenticated, encrypted connection to a paired device.
pub struct Session {
    stream: TcpStream,
    transport: TransportState,
}

impl Session {
    fn finish(stream: TcpStream, handshake: HandshakeState) -> Result<Self> {
        let transport = handshake.into_transport_mode().map_err(noise)?;
        set_timeout(&stream, IO_TIMEOUT)?;
        Ok(Session { stream, transport })
    }

    fn seal_frame(&mut self, plaintext: &[u8]) -> Result<()> {
        let mut frame = vec![0u8; plaintext.len() + NOISE_TAG];
        let written = self
            .transport
            .write_message(plaintext, &mut frame)
            .map_err(noise)?;
        write_frame(&mut self.stream, &frame[..written])
    }

    fn open_frame(&mut self) -> Result<Vec<u8>> {
        let frame = read_frame(&mut self.stream)?;
        let mut plaintext = vec![0u8; frame.len()];
        let read = self
            .transport
            .read_message(&frame, &mut plaintext)
            .map_err(noise)?;
        plaintext.truncate(read);
        Ok(plaintext)
    }

    fn send(&mut self, message: &Message) -> Result<()> {
        let json = serde_json::to_vec(message).map_err(|error| Error::Codec(error.to_string()))?;
        let body = zstd::stream::encode_all(Cursor::new(json), 3)
            .map_err(|error| Error::Codec(format!("compression: {error}")))?;
        if body.len() > MAX_MESSAGE_BYTES {
            return Err(Error::Codec(
                "this backlog is too large for local sync; the relay will deliver it".into(),
            ));
        }
        self.seal_frame(&(body.len() as u32).to_be_bytes())?;
        for chunk in body.chunks(CHUNK) {
            self.seal_frame(chunk)?;
        }
        Ok(())
    }

    fn recv(&mut self) -> Result<Message> {
        let header = self.open_frame()?;
        let length = <[u8; 4]>::try_from(header.as_slice())
            .map(u32::from_be_bytes)
            .map_err(|_| Error::Codec("malformed local sync message header".into()))?
            as usize;
        if length > MAX_MESSAGE_BYTES {
            return Err(Error::Codec("local sync message is larger than allowed".into()));
        }
        let mut body = Vec::with_capacity(length);
        while body.len() < length {
            let chunk = self.open_frame()?;
            if chunk.is_empty() || body.len() + chunk.len() > length {
                return Err(Error::Codec("malformed local sync message body".into()));
            }
            body.extend_from_slice(&chunk);
        }
        let mut json = Vec::new();
        zstd::stream::read::Decoder::new(Cursor::new(body))
            .map_err(|error| Error::Codec(format!("decompression: {error}")))?
            .take(MAX_PLAINTEXT_BYTES + 1)
            .read_to_end(&mut json)
            .map_err(|error| Error::Codec(format!("decompression: {error}")))?;
        if json.len() as u64 > MAX_PLAINTEXT_BYTES {
            return Err(Error::Codec("local sync message is larger than allowed".into()));
        }
        serde_json::from_slice(&json).map_err(|error| Error::Codec(error.to_string()))
    }
}

/// Dial a peer and authenticate it.
pub fn connect(address: SocketAddr, keys: &LanKeys) -> Result<Session> {
    let stream = TcpStream::connect_timeout(&address, CONNECT_TIMEOUT).map_err(io)?;
    initiate(stream, keys)
}

/// Initiator half of the handshake on an already-connected stream.
pub fn initiate(mut stream: TcpStream, keys: &LanKeys) -> Result<Session> {
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    set_timeout(&stream, HANDSHAKE_TIMEOUT)?;
    stream.set_nodelay(true).map_err(io)?;
    let mut handshake = keys.builder()?.build_initiator().map_err(noise)?;
    let mut buffer = [0u8; MAX_HANDSHAKE_FRAME];
    let written = handshake.write_message(&[], &mut buffer).map_err(noise)?;
    write_frame(&mut stream, &buffer[..written])?;
    // A responder with another key drops the connection instead of replying.
    let reply = read_handshake_frame(&mut stream, deadline).map_err(|error| match error {
        Error::Codec(message) if message == TIMEOUT_MESSAGE => Error::Codec(message),
        _ => Error::Crypto("the other device did not accept this pairing key".into()),
    })?;
    handshake
        .read_message(&reply, &mut buffer)
        .map_err(noise)?;
    Session::finish(stream, handshake)
}

/// Responder half of the handshake. Fails, without replying, unless the
/// initiator proves it holds the same pairing key.
pub fn accept(mut stream: TcpStream, keys: &LanKeys) -> Result<Session> {
    let deadline = Instant::now() + HANDSHAKE_TIMEOUT;
    set_timeout(&stream, HANDSHAKE_TIMEOUT)?;
    stream.set_nodelay(true).map_err(io)?;
    let mut handshake = keys.builder()?.build_responder().map_err(noise)?;
    let mut buffer = [0u8; MAX_HANDSHAKE_FRAME];
    let first = read_handshake_frame(&mut stream, deadline)?;
    handshake.read_message(&first, &mut buffer).map_err(noise)?;
    let written = handshake.write_message(&[], &mut buffer).map_err(noise)?;
    write_frame(&mut stream, &buffer[..written])?;
    Session::finish(stream, handshake)
}

/// Initiator half of one bidirectional exchange.
pub fn run_initiator(session: &mut Session, store: &dyn SyncStore) -> Result<Outcome> {
    let inventory = store.inventory()?;
    session.send(&Message::Offer {
        v: PROTOCOL_VERSION,
        inventory,
    })?;

    let (ops, want) = match session.recv()? {
        Message::Diff { ops, want } => (ops, want),
        Message::Incompatible { .. } => return Err(Error::Codec(VERSION_MESSAGE.into())),
        _ => return Err(Error::Codec("unexpected reply to a local sync offer".into())),
    };

    // Answer the peer before merging: everything below is local work.
    let requested = store.ops_by_id(&want)?;
    session.send(&Message::Ops { ops: requested })?;
    let received = store.merge(ops)?;

    match session.recv()? {
        Message::Merged { inserted } => Ok(Outcome {
            received,
            delivered: inserted,
        }),
        Message::MergeFailed { error } => Err(Error::Codec(format!(
            "the other device could not apply these changes: {error}"
        ))),
        _ => Err(Error::Codec("unexpected local sync acknowledgement".into())),
    }
}

/// Responder half of one bidirectional exchange. Returns how many operations
/// this device inserted.
pub fn run_responder(session: &mut Session, store: &dyn SyncStore) -> Result<usize> {
    let inventory = match session.recv()? {
        Message::Offer { v, inventory } if v == PROTOCOL_VERSION => inventory,
        Message::Offer { .. } => {
            session.send(&Message::Incompatible {
                v: PROTOCOL_VERSION,
            })?;
            return Err(Error::Codec(VERSION_MESSAGE.into()));
        }
        _ => return Err(Error::Codec("expected a local sync offer".into())),
    };

    // Bounded id-set diff only; no rematerialization before the reply.
    let (ops, want) = store.diff(&inventory)?;
    session.send(&Message::Diff { ops, want })?;

    let received = match session.recv()? {
        Message::Ops { ops } => ops,
        _ => return Err(Error::Codec("unexpected reply to a local sync diff".into())),
    };
    match store.merge(received) {
        Ok(inserted) => {
            // The merge is committed whether or not the initiator is still
            // listening, so a lost acknowledgement is not a local failure.
            let _ = session.send(&Message::Merged { inserted });
            Ok(inserted)
        }
        Err(error) => {
            let _ = session.send(&Message::MergeFailed {
                error: error.to_string(),
            });
            Err(error)
        }
    }
}

/// Dial `address`, authenticate, and run one exchange.
pub fn sync_with(address: SocketAddr, keys: &LanKeys, store: &dyn SyncStore) -> Result<Outcome> {
    let mut session = connect(address, keys)?;
    run_initiator(&mut session, store)
}

/// Authenticate an accepted connection and serve one exchange.
pub fn serve(stream: TcpStream, keys: &LanKeys, store: &dyn SyncStore) -> Result<usize> {
    let mut session = accept(stream, keys)?;
    run_responder(&mut session, store)
}

#[cfg(test)]
mod tests {
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Mutex;

    use super::*;
    use crate::sync::InventoryItem;

    /// An in-memory operation log with call counters.
    #[derive(Default)]
    struct MemoryStore {
        ops: Mutex<Vec<Op>>,
        fail_merge: bool,
        calls: AtomicUsize,
    }

    impl MemoryStore {
        fn with(ops: Vec<Op>) -> Self {
            MemoryStore {
                ops: Mutex::new(ops),
                ..MemoryStore::default()
            }
        }

        fn ids(&self) -> Vec<String> {
            let mut ids = self
                .ops
                .lock()
                .unwrap()
                .iter()
                .map(|op| op.id.clone())
                .collect::<Vec<_>>();
            ids.sort();
            ids
        }
    }

    impl SyncStore for MemoryStore {
        fn inventory(&self) -> Result<SyncInventory> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            Ok(SyncInventory {
                items: self
                    .ops
                    .lock()
                    .unwrap()
                    .iter()
                    .map(|op| InventoryItem {
                        id: op.id.clone(),
                        device_id: op.device_id.clone(),
                        sequence: op.sequence,
                        generation: None,
                    })
                    .collect(),
                frontiers: Default::default(),
            })
        }

        fn diff(&self, peer: &SyncInventory) -> Result<(Vec<Op>, Vec<String>)> {
            self.calls.fetch_add(1, Ordering::SeqCst);
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
            self.calls.fetch_add(1, Ordering::SeqCst);
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
            self.calls.fetch_add(1, Ordering::SeqCst);
            if self.fail_merge {
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

    fn operation(id: &str, device: &str, payload: &str) -> Op {
        Op {
            id: id.into(),
            device_id: device.into(),
            sequence: 1,
            op_type: "patch_plan_item".into(),
            timestamp: "2026-10-23T12:00:00.000Z".into(),
            payload_json: payload.into(),
        }
    }

    fn task(id: &str, device: &str) -> Op {
        operation(
            id,
            device,
            r#"{"planId":"synthetic-plan","itemId":"synthetic-task","patch":{"done":true}}"#,
        )
    }

    fn keys() -> LanKeys {
        LanKeys::derive(&SyncKey::generate())
    }

    /// Serve one connection on a loopback listener in a background thread.
    fn responder<'a>(
        scope: &'a std::thread::Scope<'a, '_>,
        keys: &'a LanKeys,
        store: &'a MemoryStore,
    ) -> (SocketAddr, std::thread::ScopedJoinHandle<'a, Result<usize>>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let handle = scope.spawn(move || {
            let (stream, _) = listener.accept().unwrap();
            serve(stream, keys, store)
        });
        (address, handle)
    }

    #[test]
    fn derived_keys_are_separate_and_tags_identify_only_the_same_pairing() {
        let key = SyncKey::generate();
        let mine = LanKeys::derive(&key);
        let again = LanKeys::derive(&key);
        assert_ne!(*mine.psk, *key.as_bytes());
        assert_ne!(*mine.discovery, *key.as_bytes());
        assert_ne!(*mine.psk, *mine.discovery);

        let tag = mine.discovery_tag("0123456789abcdef");
        assert_eq!(tag.len(), TAG_BYTES * 2);
        assert!(again.recognizes("0123456789abcdef", &tag));
        assert_ne!(tag, mine.discovery_tag("fedcba9876543210"), "salts unlink launches");
        assert!(!mine.recognizes("fedcba9876543210", &tag));
        assert!(!keys().recognizes("0123456789abcdef", &tag));
        let mut flipped = tag.clone().into_bytes();
        flipped[0] = if flipped[0] == b'0' { b'1' } else { b'0' };
        assert!(!mine.recognizes("0123456789abcdef", std::str::from_utf8(&flipped).unwrap()));
        assert!(!mine.recognizes("0123456789abcdef", &tag[..TAG_BYTES]));
        assert!(!mine.recognizes("0123456789abcdef", "not hex at all, but the right size!"));
    }

    #[test]
    fn paired_devices_exchange_both_ways_and_the_receiver_acknowledges() {
        let keys = keys();
        let phone = MemoryStore::with(vec![task("phone-completion", "phone")]);
        let desktop = MemoryStore::with(vec![task("desktop-completion", "desktop")]);
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &desktop);
            let outcome = sync_with(address, &keys, &phone).unwrap();
            assert_eq!(
                outcome,
                Outcome {
                    received: 1,
                    delivered: 1
                }
            );
            assert_eq!(served.join().unwrap().unwrap(), 1);
        });
        assert_eq!(phone.ids(), ["desktop-completion", "phone-completion"]);
        assert_eq!(desktop.ids(), phone.ids());

        // Once converged, a pass moves nothing.
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &desktop);
            assert_eq!(sync_with(address, &keys, &phone).unwrap(), Outcome::default());
            assert_eq!(served.join().unwrap().unwrap(), 0);
        });
    }

    #[test]
    fn large_incompressible_messages_span_many_encrypted_frames() {
        use rand::RngCore;
        let keys = keys();
        let mut noise = vec![0u8; 600 * 1024];
        rand::rngs::OsRng.fill_bytes(&mut noise);
        let payload = format!(r#"{{"blob":"{}"}}"#, data_encoding::BASE64.encode(&noise));
        let phone = MemoryStore::with(vec![operation("large", "phone", &payload)]);
        let desktop = MemoryStore::default();
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &desktop);
            assert_eq!(sync_with(address, &keys, &phone).unwrap().delivered, 1);
            assert_eq!(served.join().unwrap().unwrap(), 1);
        });
        assert_eq!(desktop.ops.lock().unwrap()[0].payload_json, payload);
    }

    #[test]
    fn a_device_with_another_key_never_reaches_the_database() {
        let (mine, theirs) = (keys(), keys());
        let phone = MemoryStore::with(vec![task("phone-completion", "phone")]);
        let desktop = MemoryStore::with(vec![task("desktop-completion", "desktop")]);
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &mine, &desktop);
            let error = sync_with(address, &theirs, &phone).unwrap_err();
            assert!(
                error.to_string().contains("did not accept this pairing key"),
                "{error}"
            );
            assert!(matches!(served.join().unwrap(), Err(Error::Crypto(_))));
        });
        assert_eq!(desktop.calls.load(Ordering::SeqCst), 0);
        assert_eq!(phone.calls.load(Ordering::SeqCst), 0);
        assert_eq!(desktop.ids(), ["desktop-completion"]);
    }

    #[test]
    fn a_recorded_session_replayed_to_the_device_is_rejected() {
        let keys = keys();
        let phone = MemoryStore::with(vec![task("phone-completion", "phone")]);
        let desktop = MemoryStore::default();
        // Record everything the phone sends through a forwarding proxy.
        let recorded = std::thread::scope(|scope| {
            let (target, served) = responder(scope, &keys, &desktop);
            let proxy = TcpListener::bind("127.0.0.1:0").unwrap();
            let proxy_address = proxy.local_addr().unwrap();
            let recorder = scope.spawn(move || {
                let (mut client, _) = proxy.accept().unwrap();
                let mut server = TcpStream::connect(target).unwrap();
                let mut to_client = server.try_clone().unwrap();
                let mut from_client = client.try_clone().unwrap();
                let backwards = std::thread::spawn(move || {
                    let _ = std::io::copy(&mut to_client, &mut client);
                });
                let mut recorded = Vec::new();
                let mut buffer = [0u8; 8192];
                loop {
                    match from_client.read(&mut buffer) {
                        Ok(0) | Err(_) => break,
                        Ok(read) => {
                            recorded.extend_from_slice(&buffer[..read]);
                            server.write_all(&buffer[..read]).unwrap();
                        }
                    }
                }
                let _ = server.shutdown(std::net::Shutdown::Write);
                let _ = backwards.join();
                recorded
            });
            sync_with(proxy_address, &keys, &phone).unwrap();
            assert_eq!(served.join().unwrap().unwrap(), 1);
            recorder.join().unwrap()
        });
        assert!(recorded.len() > 100);

        let fresh = MemoryStore::default();
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &fresh);
            let mut attacker = TcpStream::connect(address).unwrap();
            attacker.write_all(&recorded).unwrap();
            let error = served.join().unwrap().unwrap_err();
            assert!(matches!(error, Error::Crypto(_)), "{error}");
        });
        assert_eq!(fresh.calls.load(Ordering::SeqCst), 0, "replay never reached the store");
        assert!(fresh.ids().is_empty());
    }

    #[test]
    fn altered_frames_are_rejected_after_the_handshake() {
        let keys = keys();
        let desktop = MemoryStore::default();
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &desktop);
            let mut session = connect(address, &keys).unwrap();
            let header = 16u32.to_be_bytes();
            let mut frame = vec![0u8; header.len() + NOISE_TAG];
            let written = session.transport.write_message(&header, &mut frame).unwrap();
            frame[1] ^= 0x40;
            write_frame(&mut session.stream, &frame[..written]).unwrap();
            assert!(matches!(served.join().unwrap(), Err(Error::Crypto(_))));
        });
        assert_eq!(desktop.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn unauthenticated_peers_cannot_send_large_frames_or_hold_a_connection() {
        let keys = keys();
        let desktop = MemoryStore::default();
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &desktop);
            let mut attacker = TcpStream::connect(address).unwrap();
            attacker.write_all(&u16::MAX.to_be_bytes()).unwrap();
            let error = served.join().unwrap().unwrap_err();
            assert!(error.to_string().contains("larger than allowed"), "{error}");
        });
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &desktop);
            let _silent = TcpStream::connect(address).unwrap();
            let started = Instant::now();
            let error = served.join().unwrap().unwrap_err();
            assert!(started.elapsed() < HANDSHAKE_TIMEOUT + Duration::from_secs(2));
            assert_eq!(error.to_string(), format!("codec: {TIMEOUT_MESSAGE}"));
        });
        // One byte at a time cannot outlast the handshake deadline either.
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &desktop);
            let mut attacker = TcpStream::connect(address).unwrap();
            let started = Instant::now();
            let dribble = scope.spawn(move || {
                attacker.write_all(&48u16.to_be_bytes()).unwrap();
                while attacker.write_all(&[0]).is_ok() && started.elapsed() < Duration::from_secs(10) {
                    std::thread::sleep(Duration::from_millis(250));
                }
            });
            let error = served.join().unwrap().unwrap_err();
            assert!(started.elapsed() < HANDSHAKE_TIMEOUT + Duration::from_secs(2));
            assert_eq!(error.to_string(), format!("codec: {TIMEOUT_MESSAGE}"));
            dribble.join().unwrap();
        });
        assert_eq!(desktop.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn a_different_protocol_version_stops_before_any_operations_move() {
        let keys = keys();
        let desktop = MemoryStore::with(vec![task("desktop-completion", "desktop")]);
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &desktop);
            let mut session = connect(address, &keys).unwrap();
            session
                .send(&Message::Offer {
                    v: PROTOCOL_VERSION + 1,
                    inventory: SyncInventory::default(),
                })
                .unwrap();
            assert!(matches!(
                session.recv().unwrap(),
                Message::Incompatible { v } if v == PROTOCOL_VERSION
            ));
            let error = served.join().unwrap().unwrap_err();
            assert!(error.to_string().contains("incompatible"), "{error}");
        });
        assert_eq!(desktop.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn the_initiator_learns_when_the_receiver_could_not_apply_its_changes() {
        let keys = keys();
        let phone = MemoryStore::with(vec![task("phone-completion", "phone")]);
        let desktop = MemoryStore {
            ops: Mutex::new(vec![task("desktop-completion", "desktop")]),
            fail_merge: true,
            ..MemoryStore::default()
        };
        std::thread::scope(|scope| {
            let (address, served) = responder(scope, &keys, &desktop);
            let error = sync_with(address, &keys, &phone).unwrap_err();
            assert!(
                error.to_string().contains("synthetic receiver transaction failed"),
                "{error}"
            );
            assert!(served.join().unwrap().is_err());
        });
        // The initiator's own merge still committed.
        assert_eq!(phone.ids(), ["desktop-completion", "phone-completion"]);
        assert_eq!(desktop.ids(), ["desktop-completion"]);
    }
}
