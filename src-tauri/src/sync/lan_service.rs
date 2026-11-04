//! Runs local-network sync inside the app: a listener that serves paired
//! devices, mDNS advertisement and discovery, and outgoing passes driven by the
//! frontend's sync scheduler. The protocol itself lives in [`super::lan`].

use std::collections::HashMap;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock, RwLock};
use std::time::{Duration, Instant};

use mdns_sd::{ServiceDaemon, ServiceEvent, ServiceInfo};
use rand::RngCore;
use rusqlite::Connection;
use serde::Serialize;
use tauri::AppHandle;

use super::crypto::SyncKey;
use super::lan::{self, LanKeys};
use super::{Error, Op, Result, SyncInventory, SyncStore};

const SERVICE_TYPE: &str = "_balance-sync._tcp.local.";
// Handshakes are cheap and finish within lan::HANDSHAKE_TIMEOUT, so a few
// concurrent connections are plenty; extra unauthenticated ones are dropped.
const MAX_INBOUND: usize = 4;
// Advertisements are unauthenticated: anyone on the network can copy a tag, so
// bound how much work they can cause. Copies only ever fail the handshake.
const MAX_PEERS: usize = 64;
const MAX_ADDRESSES_PER_PEER: usize = 4;
const MAX_PEERS_PER_PASS: usize = 8;
const FIRST_RETRY: Duration = Duration::from_secs(15);
const MAX_RETRY: Duration = Duration::from_secs(5 * 60);

struct Peer {
    salt: String,
    tag: String,
    addresses: Vec<SocketAddr>,
    failures: u32,
    retry_at: Option<Instant>,
}

struct Keys {
    tag: String,
    keys: Arc<LanKeys>,
}

struct Service {
    app: AppHandle,
    discovery: Discovery,
    keys: RwLock<Option<Keys>>,
    inbound: AtomicUsize,
    outgoing: Mutex<()>,
    last_direct_sync_ms: Mutex<Option<i64>>,
}

static SERVICE: OnceLock<Service> = OnceLock::new();
static START: Mutex<()> = Mutex::new(());

#[derive(Debug, Default, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PassResult {
    /// Devices this pass exchanged with successfully.
    pub synced_devices: usize,
    pub pulled_operations: usize,
    pub pushed_operations: usize,
    pub state_changed: bool,
    /// Latest successful direct exchange in either direction.
    pub last_direct_sync_ms: Option<i64>,
    pub error: Option<String>,
}

fn random_salt() -> String {
    let mut bytes = [0u8; 8];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    super::hex(&bytes)
}

/// Addresses a nearby device can really have, best first. An advertisement
/// must never make this device dial the internet or itself.
fn local_addresses(ips: impl Iterator<Item = IpAddr>, port: u16) -> Vec<SocketAddr> {
    let mut addresses = ips
        .filter_map(|ip| match ip {
            IpAddr::V4(ip) if ip.is_private() || ip.is_link_local() => Some(ip),
            _ => None,
        })
        .collect::<Vec<_>>();
    addresses.sort_by_key(|ip| (ip.is_link_local(), *ip));
    addresses.truncate(MAX_ADDRESSES_PER_PEER);
    addresses
        .into_iter()
        .map(|ip| SocketAddr::new(IpAddr::V4(ip), port))
        .collect()
}

fn instance_name(salt: &str) -> String {
    format!("balance-{salt}")
}

/// Whether the listener is running on a key, so a pass need not open the
/// database to find it.
pub fn has_key() -> bool {
    SERVICE.get().is_some_and(|service| service.keys().is_some())
}

/// Stop serving the current key immediately, for when the pairing changes. The
/// next pass installs the new one.
pub fn forget_key() {
    if let Some(service) = SERVICE.get() {
        if let Ok(mut keys) = service.keys.write() {
            *keys = None;
        }
    }
}

/// Start the listener and discovery once, and keep them on the current key.
pub fn ensure(app: &AppHandle, key: &SyncKey) -> Result<()> {
    let keys = Arc::new(LanKeys::derive(key));
    let service = match SERVICE.get() {
        Some(service) => service,
        None => {
            let _start = START.lock().map_err(|_| Error::Codec("local sync start lock".into()))?;
            match SERVICE.get() {
                Some(service) => service,
                None => start(app)?,
            }
        }
    };
    service.install(keys);
    Ok(())
}

fn start(app: &AppHandle) -> Result<&'static Service> {
    let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, 0))
        .map_err(|error| Error::Codec(format!("local sync listener: {error}")))?;
    let port = listener
        .local_addr()
        .map_err(|error| Error::Codec(error.to_string()))?
        .port();
    #[cfg(target_os = "android")]
    android::hold_multicast_lock(app);
    let service = Service {
        app: app.clone(),
        discovery: Discovery::start(port),
        keys: RwLock::new(None),
        inbound: AtomicUsize::new(0),
        outgoing: Mutex::new(()),
        last_direct_sync_ms: Mutex::new(None),
    };
    if SERVICE.set(service).is_err() {
        return Err(Error::Codec("local sync started twice".into()));
    }
    let service = SERVICE.get().expect("local sync service was just set");
    std::thread::Builder::new()
        .name("balance-local-sync".into())
        .spawn(move || service.accept_loop(listener))
        .map_err(|error| Error::Codec(error.to_string()))?;
    Ok(service)
}

impl Service {
    fn install(&self, keys: Arc<LanKeys>) {
        let tag = keys.discovery_tag(&self.discovery.salt);
        let Ok(mut current) = self.keys.write() else {
            return;
        };
        if current.as_ref().is_some_and(|current| current.tag == tag) {
            return;
        }
        *current = Some(Keys {
            tag: tag.clone(),
            keys,
        });
        drop(current);
        self.discovery.advertise(&tag);
    }

    fn keys(&self) -> Option<Arc<LanKeys>> {
        self.keys.read().ok()?.as_ref().map(|keys| keys.keys.clone())
    }

    fn accept_loop(&'static self, listener: TcpListener) {
        for stream in listener.incoming() {
            let stream = match stream {
                Ok(stream) => stream,
                Err(error) => {
                    log::warn!("Local sync accept failed: {error}");
                    std::thread::sleep(Duration::from_millis(250));
                    continue;
                }
            };
            if self.inbound.fetch_add(1, Ordering::SeqCst) >= MAX_INBOUND {
                self.inbound.fetch_sub(1, Ordering::SeqCst);
                continue;
            }
            let Some(keys) = self.keys() else {
                self.inbound.fetch_sub(1, Ordering::SeqCst);
                continue;
            };
            let spawned = std::thread::Builder::new()
                .name("balance-local-sync-peer".into())
                .spawn(move || {
                    let result = self.serve(stream, &keys);
                    self.inbound.fetch_sub(1, Ordering::SeqCst);
                    if let Err(error) = result {
                        log::debug!("Local sync from a nearby device failed: {error}");
                    }
                });
            if spawned.is_err() {
                self.inbound.fetch_sub(1, Ordering::SeqCst);
            }
        }
    }

    fn serve(&self, stream: TcpStream, keys: &LanKeys) -> Result<()> {
        let inserted = lan::serve(stream, keys, &AppStore { app: &self.app })?;
        self.record_success();
        if inserted > 0 {
            crate::after_local_network_merge(&self.app);
        }
        Ok(())
    }

    fn record_success(&self) {
        if let Ok(mut last) = self.last_direct_sync_ms.lock() {
            *last = Some(crate::current_timestamp_ms());
        }
    }

    fn last_direct_sync_ms(&self) -> Option<i64> {
        self.last_direct_sync_ms.lock().ok().and_then(|last| *last)
    }
}

/// mDNS advertisement and discovery of nearby Balance devices. Only devices
/// whose advertised tag matches the current key count as paired peers.
pub struct Discovery {
    salt: String,
    port: u16,
    daemon: Option<ServiceDaemon>,
    peers: Arc<Mutex<HashMap<String, Peer>>>,
}

impl Discovery {
    pub fn start(port: u16) -> Self {
        let daemon = ServiceDaemon::new()
            .map_err(|error| log::warn!("mDNS is unavailable; local sync discovery is off: {error}"))
            .ok();
        let discovery = Discovery {
            salt: random_salt(),
            port,
            daemon,
            peers: Arc::new(Mutex::new(HashMap::new())),
        };
        discovery.browse();
        discovery
    }

    pub fn salt(&self) -> &str {
        &self.salt
    }

    /// Every Balance device seen, paired or not.
    #[cfg(test)]
    pub(crate) fn advertised_devices(&self) -> usize {
        self.peers.lock().map_or(0, |peers| peers.len())
    }

    pub fn advertise(&self, tag: &str) {
        let Some(daemon) = &self.daemon else {
            return;
        };
        let name = instance_name(&self.salt);
        let properties = HashMap::from([
            ("s".to_string(), self.salt.clone()),
            ("t".to_string(), tag.to_string()),
        ]);
        match ServiceInfo::new(
            SERVICE_TYPE,
            &name,
            &format!("{name}.local."),
            "",
            self.port,
            properties,
        ) {
            Ok(info) => {
                if let Err(error) = daemon.register(info.enable_addr_auto()) {
                    log::warn!("Could not advertise local sync: {error}");
                }
            }
            Err(error) => log::warn!("Could not describe local sync service: {error}"),
        }
    }

    fn browse(&self) {
        let Some(daemon) = &self.daemon else {
            return;
        };
        let receiver = match daemon.browse(SERVICE_TYPE) {
            Ok(receiver) => receiver,
            Err(error) => {
                log::warn!("Could not browse for nearby devices: {error}");
                return;
            }
        };
        let own = format!("{}.{SERVICE_TYPE}", instance_name(&self.salt));
        let peers = self.peers.clone();
        let spawned = std::thread::Builder::new()
            .name("balance-local-discovery".into())
            .spawn(move || {
                while let Ok(event) = receiver.recv() {
                    match event {
                        ServiceEvent::ServiceResolved(info) if info.fullname != own => {
                            let (Some(salt), Some(tag)) = (
                                info.get_property_val_str("s"),
                                info.get_property_val_str("t"),
                            ) else {
                                continue;
                            };
                            let addresses = local_addresses(
                                info.addresses.iter().map(|address| address.to_ip_addr()),
                                info.port,
                            );
                            if addresses.is_empty() {
                                continue;
                            }
                            if let Ok(mut peers) = peers.lock() {
                                if peers.len() >= MAX_PEERS && !peers.contains_key(&info.fullname) {
                                    continue;
                                }
                                peers.insert(
                                    info.fullname.clone(),
                                    Peer {
                                        salt: salt.to_string(),
                                        tag: tag.to_string(),
                                        addresses,
                                        failures: 0,
                                        retry_at: None,
                                    },
                                );
                            }
                        }
                        ServiceEvent::ServiceRemoved(_, fullname) => {
                            if let Ok(mut peers) = peers.lock() {
                                peers.remove(&fullname);
                            }
                        }
                        _ => {}
                    }
                }
            });
        if let Err(error) = spawned {
            log::warn!("Could not start local sync discovery: {error}");
        }
    }

    /// Paired devices advertising now that are not backing off.
    pub fn due(&self, keys: &LanKeys) -> Vec<(String, Vec<SocketAddr>)> {
        let now = Instant::now();
        let Ok(peers) = self.peers.lock() else {
            return Vec::new();
        };
        peers
            .iter()
            .filter(|(_, peer)| keys.recognizes(&peer.salt, &peer.tag))
            .filter(|(_, peer)| peer.retry_at.map_or(true, |at| at <= now))
            .take(MAX_PEERS_PER_PASS)
            .map(|(name, peer)| (name.clone(), peer.addresses.clone()))
            .collect()
    }

    fn record(&self, name: &str, succeeded: bool) {
        let Ok(mut peers) = self.peers.lock() else {
            return;
        };
        let Some(peer) = peers.get_mut(name) else {
            return;
        };
        if succeeded {
            peer.failures = 0;
            peer.retry_at = None;
        } else {
            // A stale advertisement or a device that went to sleep must not
            // slow every pass; back off and let mDNS refresh it.
            peer.failures = peer.failures.saturating_add(1);
            let backoff = FIRST_RETRY
                .saturating_mul(1 << (peer.failures.min(5) - 1))
                .min(MAX_RETRY);
            peer.retry_at = Some(Instant::now() + backoff);
        }
    }
}

/// Exchange with every paired device advertising on this network.
pub fn sync_nearby() -> PassResult {
    let Some(service) = SERVICE.get() else {
        return PassResult::default();
    };
    let Some(keys) = service.keys() else {
        return PassResult::default();
    };
    // The scheduler serializes passes; this only guards overlapping callers.
    let Ok(_outgoing) = service.outgoing.try_lock() else {
        return PassResult {
            last_direct_sync_ms: service.last_direct_sync_ms(),
            ..PassResult::default()
        };
    };
    let due = service.discovery.due(&keys);

    let outcomes = std::thread::scope(|scope| {
        let handles = due
            .into_iter()
            .map(|(name, addresses)| {
                let keys = &keys;
                scope.spawn(move || {
                    let store = AppStore { app: &service.app };
                    let mut last_error = None;
                    for address in addresses {
                        match lan::sync_with(address, keys, &store) {
                            Ok(outcome) => return (name, Ok(outcome)),
                            Err(error) => last_error = Some(error),
                        }
                    }
                    (
                        name,
                        Err(last_error.unwrap_or_else(|| Error::Codec("no address".into()))),
                    )
                })
            })
            .collect::<Vec<_>>();
        handles
            .into_iter()
            .filter_map(|handle| handle.join().ok())
            .collect::<Vec<_>>()
    });

    let mut result = PassResult::default();
    for (name, outcome) in outcomes {
        service.discovery.record(&name, outcome.is_ok());
        match outcome {
            Ok(outcome) => {
                result.synced_devices += 1;
                result.pulled_operations += outcome.received;
                result.pushed_operations += outcome.delivered;
            }
            Err(error) => {
                log::debug!("Local sync with a nearby device failed: {error}");
                result.error = Some(error.to_string());
            }
        }
    }
    if result.synced_devices > 0 {
        service.record_success();
    }
    result.state_changed = result.pulled_operations > 0;
    result.last_direct_sync_ms = service.last_direct_sync_ms();
    result
}

/// [`SyncStore`] over the live app database.
///
/// Every method takes the global `DATABASE_ACCESS_LOCK`, opens its own
/// connection, does its work, and releases both. Holding neither across socket
/// I/O is what lets two devices sync *at each other* simultaneously: neither
/// can be parked on a socket read while owning the lock the other needs.
struct AppStore<'a> {
    app: &'a AppHandle,
}

impl AppStore<'_> {
    fn with_connection<T>(&self, task: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
        let _guard =
            crate::database_access_guard(crate::freeze_diagnostics::DatabaseUser::LocalNetwork)
                .map_err(Error::Codec)?;
        let connection = crate::open_database(self.app).map_err(Error::Codec)?;
        task(&connection)
    }
}

impl SyncStore for AppStore<'_> {
    fn inventory(&self) -> Result<SyncInventory> {
        self.with_connection(super::sync_inventory)
    }

    fn diff(&self, peer: &SyncInventory) -> Result<(Vec<Op>, Vec<String>)> {
        self.with_connection(|connection| super::diff_against(connection, peer))
    }

    fn ops_by_id(&self, ids: &[String]) -> Result<Vec<Op>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        self.with_connection(|connection| super::ops_by_id(connection, ids))
    }

    fn merge(&self, ops: Vec<Op>) -> Result<usize> {
        if ops.is_empty() {
            return Ok(0);
        }
        self.with_connection(move |connection| super::merge_and_rematerialize(connection, ops))
    }
}

#[cfg(target_os = "android")]
mod android {
    use std::sync::OnceLock;
    use std::time::Duration;

    use jni::objects::{GlobalRef, JValue};
    use tauri::{AppHandle, Manager};

    static MULTICAST_LOCK: OnceLock<GlobalRef> = OnceLock::new();

    /// Android drops incoming multicast, including mDNS, unless an app holds a
    /// Wi-Fi multicast lock.
    pub(super) fn hold_multicast_lock(app: &AppHandle) {
        if MULTICAST_LOCK.get().is_some() {
            return;
        }
        let Some(webview) = app.get_webview_window("main") else {
            return;
        };
        let (sender, receiver) = std::sync::mpsc::sync_channel(1);
        let requested = webview.with_webview(move |webview| {
            webview.jni_handle().exec(move |env, activity, _| {
                let result = (|| -> jni::errors::Result<GlobalRef> {
                    let context = env
                        .call_method(activity, "getApplicationContext", "()Landroid/content/Context;", &[])?
                        .l()?;
                    let service = env.new_string("wifi")?;
                    let manager = env
                        .call_method(
                            &context,
                            "getSystemService",
                            "(Ljava/lang/String;)Ljava/lang/Object;",
                            &[(&service).into()],
                        )?
                        .l()?;
                    let tag = env.new_string("Balance:localSync")?;
                    let lock = env
                        .call_method(
                            &manager,
                            "createMulticastLock",
                            "(Ljava/lang/String;)Landroid/net/wifi/WifiManager$MulticastLock;",
                            &[(&tag).into()],
                        )?
                        .l()?;
                    env.call_method(&lock, "setReferenceCounted", "(Z)V", &[JValue::Bool(0)])?;
                    env.call_method(&lock, "acquire", "()V", &[])?;
                    env.new_global_ref(lock)
                })();
                if env.exception_check().unwrap_or(true) {
                    let _ = env.exception_describe();
                    let _ = env.exception_clear();
                }
                let _ = sender.send(result.ok());
            });
        });
        if requested.is_err() {
            return;
        }
        match receiver.recv_timeout(Duration::from_secs(2)) {
            Ok(Some(lock)) => {
                let _ = MULTICAST_LOCK.set(lock);
            }
            _ => log::warn!("Could not hold the Wi-Fi multicast lock; nearby devices may not be found"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn advertisements_only_lead_to_addresses_on_the_local_network() {
        let ips = [
            "8.8.8.8",
            "127.0.0.1",
            "169.254.10.20",
            "0.0.0.0",
            "192.168.1.20",
            "::1",
            "fe80::1",
            "100.64.0.1",
            "224.0.0.251",
            "10.0.0.5",
        ]
        .map(|ip| ip.parse::<IpAddr>().unwrap());
        let addresses = local_addresses(ips.into_iter(), 4242)
            .into_iter()
            .map(|address| address.to_string())
            .collect::<Vec<_>>();
        assert_eq!(addresses, ["10.0.0.5:4242", "192.168.1.20:4242", "169.254.10.20:4242"]);

        let many = (1..=20).map(|host| IpAddr::V4(Ipv4Addr::new(10, 0, 0, host)));
        assert_eq!(local_addresses(many, 1).len(), MAX_ADDRESSES_PER_PEER);
    }

    #[test]
    fn repeated_failures_back_off_and_a_success_clears_them() {
        let keys = LanKeys::derive(&SyncKey::generate());
        let discovery = Discovery {
            salt: random_salt(),
            port: 1,
            daemon: None,
            peers: Arc::new(Mutex::new(HashMap::new())),
        };
        let salt = random_salt();
        discovery.peers.lock().unwrap().insert(
            "peer".into(),
            Peer {
                tag: keys.discovery_tag(&salt),
                salt,
                addresses: vec!["10.0.0.5:1".parse().unwrap()],
                failures: 0,
                retry_at: None,
            },
        );
        assert_eq!(discovery.due(&keys).len(), 1);
        assert!(discovery.due(&LanKeys::derive(&SyncKey::generate())).is_empty());
        discovery.record("peer", false);
        assert!(discovery.due(&keys).is_empty());
        discovery.record("peer", true);
        assert_eq!(discovery.due(&keys).len(), 1);
    }
}
