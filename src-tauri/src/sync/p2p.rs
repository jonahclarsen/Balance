//! LAN peer-to-peer sync: advertise this device over mDNS, discover other
//! Balance devices on the network, and exchange sealed changesets directly over
//! TCP. No server and no localhost requirement — the devices just need to be on
//! the same Wi-Fi/LAN.
//!
//! Reliability note: mDNS auto-discovery works well on desktop; on Android it
//! needs a WifiManager multicast lock (not yet wired), so the manual
//! "enter address" path is the dependable cross-platform option. Both share the
//! same sealed-changeset transport.

use std::collections::HashMap;
use std::net::{TcpListener, UdpSocket};
use std::sync::{Mutex, OnceLock};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use tauri::AppHandle;

use super::crypto::SyncKey;
use super::transport::{sync_connect, Cursors};
use super::{Error, Result};

const SERVICE_TYPE: &str = "_balance-sync._tcp.local.";

#[derive(Clone, serde::Serialize)]
pub struct Peer {
    pub name: String,
    pub address: String,
}

struct P2pState {
    local_port: u16,
    peers: Mutex<HashMap<String, Peer>>,
}

static STATE: OnceLock<P2pState> = OnceLock::new();

/// This device's best-guess LAN IP (resolved via the default route, no packets
/// actually sent).
pub fn local_ip() -> Option<String> {
    let sock = UdpSocket::bind("0.0.0.0:0").ok()?;
    sock.connect("8.8.8.8:80").ok()?;
    sock.local_addr().ok().map(|a| a.ip().to_string())
}

/// Peers discovered on the LAN so far.
pub fn peers() -> Vec<Peer> {
    STATE
        .get()
        .map(|s| s.peers.lock().unwrap().values().cloned().collect())
        .unwrap_or_default()
}

/// The address other devices should connect to (LAN ip:port), once serving.
pub fn local_address() -> Option<String> {
    let port = STATE.get()?.local_port;
    Some(format!("{}:{port}", local_ip().unwrap_or_else(|| "127.0.0.1".into())))
}

/// Idempotently start the P2P listener plus mDNS advertise + browse. Safe to
/// call on every launch / panel open — only the first call does work.
pub fn ensure_serving(app: AppHandle, key: SyncKey) -> Result<u16> {
    if let Some(s) = STATE.get() {
        return Ok(s.local_port);
    }

    let listener = TcpListener::bind("0.0.0.0:0").map_err(|e| Error::Codec(e.to_string()))?;
    let port = listener
        .local_addr()
        .map_err(|e| Error::Codec(e.to_string()))?
        .port();

    STATE
        .set(P2pState {
            local_port: port,
            peers: Mutex::new(HashMap::new()),
        })
        .ok();

    start_mdns(port);
    start_accept_loop(listener, app, key);
    Ok(port)
}

fn start_mdns(port: u16) {
    let Ok(daemon) = ServiceDaemon::new() else {
        log::warn!("mDNS unavailable; P2P discovery disabled (manual address still works)");
        return;
    };

    let instance = format!("balance-{}", std::process::id());
    let host = format!("{instance}.local.");
    if let Ok(info) = ServiceInfo::new(SERVICE_TYPE, &instance, &host, "", port, None) {
        let info = info.enable_addr_auto();
        let _ = daemon.register(info);
    }

    if let Ok(receiver) = daemon.browse(SERVICE_TYPE) {
        std::thread::spawn(move || {
            // Hold the daemon for the lifetime of the browse loop.
            let _daemon = daemon;
            while let Ok(event) = receiver.recv() {
                if let ServiceEvent::ServiceResolved(info) = event {
                    let name = info.get_fullname().to_string();
                    let Some(addr) = info.get_addresses().iter().next().copied() else {
                        continue;
                    };
                    let peer_port = info.get_port();
                    // Skip our own advertisement.
                    if peer_port == port {
                        continue;
                    }
                    if let Some(state) = STATE.get() {
                        state.peers.lock().unwrap().insert(
                            name.clone(),
                            Peer {
                                name,
                                address: format!("{addr}:{peer_port}"),
                            },
                        );
                    }
                }
            }
        });
    }
}

fn start_accept_loop(listener: TcpListener, app: AppHandle, key: SyncKey) {
    std::thread::spawn(move || {
        let mut cursors = Cursors::new();
        loop {
            if let Err(e) = serve_one(&listener, &app, &key, &mut cursors) {
                log::warn!("p2p serve error: {e}");
            }
        }
    });
}

/// Accept one inbound connection and run the responder side of a sync against a
/// fresh DB connection (with cr-sqlite loaded).
fn serve_one(
    listener: &TcpListener,
    app: &AppHandle,
    key: &SyncKey,
    cursors: &mut Cursors,
) -> Result<()> {
    let conn = crate::open_database(app).map_err(Error::Codec)?;
    let ext = crate::crsqlite_extension_path(app).map_err(Error::Codec)?;
    super::activate(&conn, &ext)?;
    let result = super::transport::sync_accept(listener, &conn, key, cursors);
    let _ = super::finalize(&conn);
    result
}

/// Initiate a one-shot bidirectional sync with a peer at `addr` (host:port).
pub fn sync_with(app: &AppHandle, key: &SyncKey, addr: &str) -> Result<()> {
    let conn = crate::open_database(app).map_err(Error::Codec)?;
    let ext = crate::crsqlite_extension_path(app).map_err(Error::Codec)?;
    super::activate(&conn, &ext)?;
    let mut cursors = Cursors::new();
    let result = sync_connect(addr, &conn, key, &mut cursors);
    let _ = super::finalize(&conn);
    result
}
