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
use std::net::{Ipv4Addr, TcpListener, UdpSocket};
use std::sync::{Mutex, OnceLock};

use if_addrs::IfAddr;
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

#[derive(Debug)]
struct LocalIpv4Candidate {
    interface_name: String,
    ip: Ipv4Addr,
    has_broadcast: bool,
}

fn is_likely_virtual_interface(name: &str) -> bool {
    let name = name.to_ascii_lowercase();
    [
        "utun", "tun", "tap", "wg", "tailscale", "zerotier", "docker", "veth", "vmnet",
        "bridge", "br-",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}

fn select_lan_ipv4(candidates: impl IntoIterator<Item = LocalIpv4Candidate>) -> Option<Ipv4Addr> {
    candidates
        .into_iter()
        .filter(|candidate| {
            !candidate.ip.is_loopback()
                && !candidate.ip.is_link_local()
                && !candidate.ip.is_unspecified()
        })
        .max_by_key(|candidate| {
            (
                !is_likely_virtual_interface(&candidate.interface_name),
                candidate.has_broadcast,
                candidate.ip.is_private(),
            )
        })
        .map(|candidate| candidate.ip)
}

/// This device's best-guess LAN IP. Prefer a physical, broadcast-capable
/// interface so an active VPN's default route does not hide the Wi-Fi address.
pub fn local_ip() -> Option<String> {
    if let Ok(interfaces) = if_addrs::get_if_addrs() {
        let candidates = interfaces.into_iter().filter_map(|interface| {
            let IfAddr::V4(address) = interface.addr else {
                return None;
            };
            Some(LocalIpv4Candidate {
                interface_name: interface.name,
                ip: address.ip,
                has_broadcast: address.broadcast.is_some(),
            })
        });
        if let Some(ip) = select_lan_ipv4(candidates) {
            return Some(ip.to_string());
        }
    }

    // Last-resort fallback for platforms where interface enumeration fails.
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
    #[cfg(target_os = "android")]
    {
        return crate::android_keystore::with_sync_wake_locks(app, || {
            sync_with_connection(app, key, addr)
        })
        .map_err(Error::Codec)?;
    }

    #[cfg(not(target_os = "android"))]
    sync_with_connection(app, key, addr)
}

fn sync_with_connection(app: &AppHandle, key: &SyncKey, addr: &str) -> Result<()> {
    let conn = crate::open_database(app).map_err(Error::Codec)?;
    let ext = crate::crsqlite_extension_path(app).map_err(Error::Codec)?;
    super::activate(&conn, &ext)?;
    let mut cursors = Cursors::new();
    let result = sync_connect(addr, &conn, key, &mut cursors);
    let _ = super::finalize(&conn);
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn candidate(name: &str, ip: [u8; 4], has_broadcast: bool) -> LocalIpv4Candidate {
        LocalIpv4Candidate {
            interface_name: name.to_string(),
            ip: Ipv4Addr::from(ip),
            has_broadcast,
        }
    }

    #[test]
    fn lan_address_prefers_wifi_over_a_vpn_default_route() {
        let selected = select_lan_ipv4([
            candidate("utun4", [10, 5, 0, 2], false),
            candidate("en0", [192, 168, 1, 248], true),
        ]);

        assert_eq!(selected, Some(Ipv4Addr::new(192, 168, 1, 248)));
    }

    #[test]
    fn lan_address_ignores_loopback_and_link_local_interfaces() {
        let selected = select_lan_ipv4([
            candidate("lo0", [127, 0, 0, 1], false),
            candidate("en0", [169, 254, 10, 20], true),
            candidate("wlan0", [10, 0, 0, 42], true),
        ]);

        assert_eq!(selected, Some(Ipv4Addr::new(10, 0, 0, 42)));
    }
}
