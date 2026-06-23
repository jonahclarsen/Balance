//! Peer-to-peer transport: two devices exchange sealed changesets directly over
//! a TCP socket (pairs with mDNS discovery on a LAN). The same `SyncKey`-sealed
//! envelopes the relay uses move over the wire, so an observer sees only
//! ciphertext.
//!
//! Cursor model: each node tracks, per peer, the high-water `db_version` of its
//! *own* database it has already sent that peer (`sent_upto`). A sync ships
//! `crsql_changes` with `db_version > sent_upto AND site_id != peer`, then
//! advances the cursor. Apply is idempotent, so a lost ack just resends.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::crypto::SyncKey;
use super::{apply, db_version, pull, site_hex, Error, Result};

#[derive(Default)]
pub struct Cursors {
    sent_upto: HashMap<String, i64>,
}

impl Cursors {
    pub fn new() -> Self {
        Cursors::default()
    }
    fn get(&self, peer: &str) -> i64 {
        self.sent_upto.get(peer).copied().unwrap_or(0)
    }
    fn set(&mut self, peer: &str, v: i64) {
        self.sent_upto.insert(peer.to_string(), v);
    }
}

#[derive(Serialize, Deserialize)]
struct Header {
    from_site: String,
    hw: i64,
}

fn write_frame(stream: &mut TcpStream, bytes: &[u8]) -> Result<()> {
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
    let mut buf = vec![0u8; u32::from_be_bytes(len) as usize];
    stream.read_exact(&mut buf).map_err(io)?;
    Ok(buf)
}

fn io(e: std::io::Error) -> Error {
    Error::Codec(format!("io: {e}"))
}

fn send(stream: &mut TcpStream, header: &Header, sealed: &[u8]) -> Result<()> {
    write_frame(
        stream,
        &serde_json::to_vec(header).map_err(|e| Error::Codec(e.to_string()))?,
    )?;
    write_frame(stream, sealed)
}

fn recv(stream: &mut TcpStream) -> Result<(Header, Vec<u8>)> {
    let hdr = read_frame(stream)?;
    let header: Header =
        serde_json::from_slice(&hdr).map_err(|e| Error::Codec(e.to_string()))?;
    Ok((header, read_frame(stream)?))
}

/// Initiator side of a one-shot bidirectional sync.
pub fn sync_connect(
    addr: &str,
    conn: &Connection,
    key: &SyncKey,
    cursors: &mut Cursors,
) -> Result<()> {
    let mut stream = TcpStream::connect(addr).map_err(io)?;
    let my_site = site_hex(conn)?;

    // Peer site unknown on this first push, so we can't exclude it; cr-sqlite
    // ignores changes the peer already has, and the return leg does exclude us.
    let outgoing = pull(conn, cursors.get("peer"), None)?;
    let hw = db_version(conn)?;
    send(&mut stream, &Header { from_site: my_site, hw }, &key.seal(&outgoing)?)?;

    let (peer_hdr, peer_sealed) = recv(&mut stream)?;
    apply(conn, &key.open(&peer_sealed)?)?;

    cursors.set(&peer_hdr.from_site, hw);
    cursors.set("peer", hw);
    Ok(())
}

/// Responder side of a one-shot bidirectional sync.
pub fn sync_accept(
    listener: &TcpListener,
    conn: &Connection,
    key: &SyncKey,
    cursors: &mut Cursors,
) -> Result<()> {
    let (mut stream, _) = listener.accept().map_err(io)?;
    let my_site = site_hex(conn)?;

    let (peer_hdr, peer_sealed) = recv(&mut stream)?;
    apply(conn, &key.open(&peer_sealed)?)?;
    let peer_site = peer_hdr.from_site.clone();

    let outgoing = pull(conn, cursors.get(&peer_site), Some(&peer_site))?;
    let hw = db_version(conn)?;
    send(&mut stream, &Header { from_site: my_site, hw }, &key.seal(&outgoing)?)?;

    cursors.set(&peer_site, hw);
    Ok(())
}
