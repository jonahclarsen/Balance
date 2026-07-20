<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import QRCode from 'qrcode'
  import {
    scan,
    cancel,
    checkPermissions,
    requestPermissions,
    Format,
  } from '@tauri-apps/plugin-barcode-scanner'
  import {
    getSyncSettings,
    setSyncRelayUrl,
    migrateLegacySyncSettings,
    syncNewPairingCode,
    syncEnablePrimary,
    syncEnableJoiner,
    syncPullSealed,
    syncApplySealed,
    syncP2pServe,
    syncP2pPeers,
    syncP2pSync,
    plannerStore,
    type SyncPeer,
  } from './store'

  // Older versions used origin-scoped localStorage, which split these values
  // between dev and production. They are read only for one-time migration into
  // encrypted, non-replicated database metadata.
  const LEGACY_STORAGE_KEY = 'balance.sync.pairingCode'
  const LEGACY_RELAY_KEY = 'balance.sync.relayUrl'

  // Camera QR scanning is mobile-only (native plugin); on desktop you paste.
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent)

  let migrated = false
  let pairingCode = ''
  let relayUrl = ''
  let qrDataUrl = ''
  let joinInput = ''
  let status = ''
  let busy = false
  let pairing = false
  let isError = false
  let scanning = false
  let copyLabel = 'Copy code'
  let copyTimer: ReturnType<typeof setTimeout> | undefined

  let localAddress = ''
  let peers: SyncPeer[] = []
  let peerAddress = ''
  let peerPoll: ReturnType<typeof setInterval> | undefined

  onMount(async () => {
    const legacyPairingCode = localStorage.getItem(LEGACY_STORAGE_KEY)
    const legacyRelayUrl = localStorage.getItem(LEGACY_RELAY_KEY)
    try {
      let settings = await getSyncSettings()
      if (legacyPairingCode !== null || legacyRelayUrl !== null) {
        try {
          settings = await migrateLegacySyncSettings(legacyPairingCode, legacyRelayUrl)
          localStorage.removeItem(LEGACY_STORAGE_KEY)
          localStorage.removeItem(LEGACY_RELAY_KEY)
        } catch (err) {
          setStatus(`Could not migrate old sync settings: ${err}`, true)
        }
      }

      migrated = settings.enabled
      pairingCode = settings.pairingCode ?? ''
      relayUrl = settings.relayUrl
    } catch (err) {
      migrated = false
      setStatus(`Could not load sync settings: ${err}`, true)
    }
    if (pairingCode) await renderQr()
    if (migrated) await startP2p()
  })

  onDestroy(() => {
    if (peerPoll) clearInterval(peerPoll)
    if (copyTimer) clearTimeout(copyTimer)
    // Make sure the camera is released and the UI restored if we unmount mid-scan.
    if (scanning) void stopScan()
  })

  // Teleport the scan overlay to <body> so it survives `#app` being hidden while
  // the native camera renders behind the (transparent) webview.
  function portal(node: HTMLElement) {
    document.body.appendChild(node)
    return { destroy: () => node.remove() }
  }

  // Open the native camera scanner and pair with whatever pairing code it reads.
  async function scanCode() {
    try {
      let perm = await checkPermissions()
      if (perm !== 'granted') perm = await requestPermissions()
      if (perm !== 'granted') {
        setStatus('Camera permission is needed to scan a code.', true)
        return
      }
    } catch (err) {
      setStatus(`Camera unavailable: ${err}`, true)
      return
    }

    scanning = true
    // The camera renders behind the webview, so hide the app and go transparent.
    document.documentElement.classList.add('qr-scanning')
    try {
      const result = await scan({ windowed: true, formats: [Format.QRCode] })
      const content = (result?.content ?? '').trim()
      // A successful native scan has already stopped and released the camera.
      // Calling cancel() here can race the successful Android callback, so only
      // restore our web UI before handing the scanned value to pairing.
      finishScanUi()
      if (!content) {
        setStatus('The scanner returned an empty QR code. Please try again.', true)
        return
      }
      joinInput = content
      await join()
    } catch (err) {
      await stopScan()
      setStatus(`Could not scan: ${err}`, true)
    }
  }

  function finishScanUi() {
    scanning = false
    document.documentElement.classList.remove('qr-scanning')
  }

  // Stop the camera and restore the normal UI. Safe to call more than once.
  async function stopScan() {
    if (!scanning) return
    finishScanUi()
    try {
      await cancel()
    } catch {
      // Already stopped (e.g. after a successful read) — nothing to cancel.
    }
  }

  // Start advertising this device on the LAN and begin polling for discovered
  // peers. Idempotent on the backend, so safe to call on every panel open.
  async function startP2p() {
    try {
      localAddress = (await syncP2pServe()) ?? ''
      await refreshPeers()
      if (!peerPoll) peerPoll = setInterval(refreshPeers, 4000)
    } catch (err) {
      // P2P is best-effort (e.g. mDNS unavailable); manual address still works.
      console.warn('P2P start failed', err)
    }
  }

  async function refreshPeers() {
    try {
      peers = await syncP2pPeers()
    } catch {
      // ignore transient discovery errors
    }
  }

  // Direct device-to-device sync over the LAN: exchange sealed changesets with a
  // peer, then reload if our state changed.
  async function syncWithPeer(address: string) {
    const addr = address.trim()
    if (!addr) return
    if (!pairingCode) {
      setStatus('Create or paste a pairing code first.', true)
      return
    }
    busy = true
    try {
      await syncP2pSync(addr)
      await plannerStore.reloadFromBackend()
      migrated = true
      setStatus(`Synced directly with ${addr}.`)
    } catch (err) {
      setStatus(`Direct sync failed: ${err}`, true)
    } finally {
      busy = false
    }
  }

  async function renderQr() {
    try {
      qrDataUrl = await QRCode.toDataURL(pairingCode, { margin: 1, width: 220 })
    } catch {
      qrDataUrl = ''
    }
  }

  function setStatus(message: string, error = false) {
    status = message
    isError = error
  }

  async function generate() {
    busy = true
    try {
      const newPairingCode = await syncNewPairingCode()
      // This device becomes the source of truth; its data is snapshotted into
      // the synced log (and backed up first).
      await syncEnablePrimary(newPairingCode)
      pairingCode = newPairingCode
      migrated = true
      await renderQr()
      await startP2p()
      setStatus('Sync enabled. Scan or paste this code on your other device to join.')
    } catch (err) {
      setStatus(`Could not create a sync key: ${err}`, true)
    } finally {
      busy = false
    }
  }

  async function join() {
    const code = joinInput.trim()
    if (!code.startsWith('BALSYNC1:')) {
      setStatus('That does not look like a Balance pairing code.', true)
      return
    }
    busy = true
    pairing = true
    setStatus('Pairing…')
    try {
      // Joining adopts the other device's data; this device's current data is
      // backed up and replaced on the next sync.
      await syncEnableJoiner(code)
      pairingCode = code
      joinInput = ''
      migrated = true
      await renderQr()
      await startP2p()
      setStatus('Paired. Use a device below (or "Sync now") to pull your data.')
    } catch (err) {
      setStatus(`Could not pair: ${err}`, true)
    } finally {
      pairing = false
      busy = false
    }
  }

  async function saveRelay() {
    busy = true
    try {
      const settings = await setSyncRelayUrl(relayUrl)
      relayUrl = settings.relayUrl
      setStatus(relayUrl ? 'Relay server saved.' : 'Relay server cleared.')
    } catch (err) {
      setStatus(`Could not save relay server: ${err}`, true)
    } finally {
      busy = false
    }
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(pairingCode)
      setStatus('Pairing code copied.')
      copyLabel = 'Copied!'
      if (copyTimer) clearTimeout(copyTimer)
      copyTimer = setTimeout(() => (copyLabel = 'Copy code'), 2000)
    } catch {
      setStatus('Copy failed — select the code and copy manually.', true)
    }
  }

  // One sync pass through the relay server: push our sealed changes, then pull
  // and apply everyone else's. The relay only ever holds ciphertext.
  async function syncNow() {
    if (!pairingCode) {
      setStatus('Create or paste a pairing code first.', true)
      return
    }
    if (!relayUrl) {
      setStatus('Set a relay server URL first.', true)
      return
    }
    busy = true
    try {
      const base = relayUrl.replace(/\/$/, '')

      // Push our sealed delta.
      const sealed = await syncPullSealed(0)
      const pushRes = await fetch(`${base}/push`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(Array.from(sealed)),
      })
      if (!pushRes.ok) throw new Error(`relay push ${pushRes.status}`)

      // Pull others' envelopes and apply them.
      const pullRes = await fetch(`${base}/pull`)
      if (!pullRes.ok) throw new Error(`relay pull ${pullRes.status}`)
      const envelopes = (await pullRes.json()) as number[][]
      let applied = 0
      for (const env of envelopes) {
        const newState = await syncApplySealed(Uint8Array.from(env))
        if (newState) applied += 1
      }
      migrated = true
      setStatus(`Synced. Applied ${applied} update(s) from the server.`)
      if (applied > 0) {
        // Rehydrate explicitly: location.reload() is unreliable in an embedded
        // mobile WebView and can leave the pre-sync store visible.
        await plannerStore.reloadFromBackend()
      }
    } catch (err) {
      setStatus(`Sync failed: ${err}`, true)
    } finally {
      busy = false
    }
  }
</script>

<section class="settings-section sync-panel">
  <div>
    <h3>Multi-device sync</h3>
    <p>
      End-to-end encrypted sync across your devices. One device creates a sync
      key; the others scan or paste its code. Your data is sealed before it
      leaves the device — the relay server only ever sees ciphertext.
    </p>
  </div>

  <div class="sync-body">
    {#if pairingCode}
      <div class="sync-pairing">
        {#if qrDataUrl}
          <img class="sync-qr" src={qrDataUrl} alt="Pairing QR code" />
        {/if}
        <div class="sync-code-block">
          <label for="sync-code">This device's pairing code</label>
          <code id="sync-code" class="sync-code">{pairingCode}</code>
          <div class="sync-actions">
            <button type="button" on:click={copyCode}>{copyLabel}</button>
            <button type="button" class="ghost" on:click={generate} disabled={busy}>
              Replace key…
            </button>
          </div>
        </div>
      </div>
    {:else}
      <button class="primary" type="button" on:click={generate} disabled={busy}>
        Create a sync key
      </button>
    {/if}

    <div class="sync-join">
      <label for="sync-join-input">Pair with another device</label>
      <p>
        {#if isMobile}
          Scan the QR code shown on your other device, or paste its pairing code.
        {:else}
          Paste the pairing code shown on your other device.
        {/if}
      </p>
      <form class="sync-actions" on:submit|preventDefault={join}>
        {#if isMobile}
          <button type="button" on:click={scanCode} disabled={busy || scanning}>
            Scan QR code
          </button>
        {/if}
        <input
          id="sync-join-input"
          type="text"
          aria-label="Pair with another device"
          placeholder="BALSYNC1:…"
          spellcheck="false"
          bind:value={joinInput}
        />
        <button type="submit" disabled={busy || !joinInput.trim()}>
          {pairing ? 'Pairing…' : 'Pair'}
        </button>
      </form>
    </div>

    {#if migrated}
      <div class="sync-p2p">
        <label for="sync-peer-input">Direct device-to-device (same Wi-Fi)</label>
        <p>
          No server needed — devices on the same network sync directly. Your data
          is sealed end-to-end either way.
        </p>
        {#if localAddress}
          <p class="sync-self">
            This device: <code>{localAddress}</code>
          </p>
        {/if}

        {#if peers.length > 0}
          <ul class="sync-peers">
            {#each peers as peer (peer.address)}
              <li>
                <span class="sync-peer-addr"><code>{peer.address}</code></span>
                <button type="button" on:click={() => syncWithPeer(peer.address)} disabled={busy}>
                  Sync
                </button>
              </li>
            {/each}
          </ul>
        {:else}
          <p class="sync-empty">No devices discovered yet. You can enter an address manually.</p>
        {/if}

        <div class="sync-actions">
          <input
            id="sync-peer-input"
            type="text"
            aria-label="Direct device-to-device (same Wi-Fi)"
            placeholder="192.168.1.42:port"
            spellcheck="false"
            bind:value={peerAddress}
          />
          <button type="button" on:click={() => syncWithPeer(peerAddress)} disabled={busy || !peerAddress.trim()}>
            Sync with address
          </button>
        </div>
      </div>
    {/if}

    <div class="sync-relay">
      <label for="sync-relay-input">Relay server (for server-mediated sync)</label>
      <p>Leave blank to use only direct device-to-device sync.</p>
      <div class="sync-actions">
        <input
          id="sync-relay-input"
          type="url"
          placeholder="https://relay.example.com"
          spellcheck="false"
          bind:value={relayUrl}
        />
        <button type="button" on:click={saveRelay} disabled={busy}>Save</button>
      </div>
    </div>

    <div class="sync-actions">
      <button class="primary" type="button" on:click={syncNow} disabled={busy}>
        {busy ? 'Syncing…' : 'Sync now'}
      </button>
      <span class="sync-state" aria-live="polite">
        {migrated ? 'Sync ready on this device.' : 'Not yet synced.'}
      </span>
    </div>

    {#if status}
      <p class="sync-status" class:error={isError} aria-live="polite">{status}</p>
    {/if}
  </div>
</section>

{#if scanning}
  <div class="qr-scan-overlay" use:portal>
    <div class="qr-scan-reticle"></div>
    <p class="qr-scan-hint">Point the camera at the pairing QR code on your other device.</p>
    <button type="button" class="qr-scan-cancel" on:click={stopScan}>Cancel</button>
  </div>
{/if}

<style>
  .sync-body {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }
  .sync-pairing {
    display: flex;
    gap: 1rem;
    align-items: flex-start;
    flex-wrap: wrap;
  }
  .sync-qr {
    border-radius: 8px;
    background: #fff;
    padding: 6px;
  }
  .sync-code-block {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 16rem;
    flex: 1;
  }
  .sync-code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.78rem;
    word-break: break-all;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    background: rgba(127, 127, 127, 0.12);
  }
  .sync-join,
  .sync-relay,
  .sync-p2p {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .sync-self code,
  .sync-peer-addr code {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 0.8rem;
  }
  .sync-peers {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .sync-peers li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.35rem 0.5rem;
    border-radius: 6px;
    background: rgba(127, 127, 127, 0.1);
  }
  .sync-empty {
    font-size: 0.82rem;
    opacity: 0.7;
    margin: 0;
  }
  .sync-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .sync-actions input {
    flex: 1;
    min-width: 12rem;
  }
  .sync-status {
    margin: 0;
    font-size: 0.85rem;
  }
  .sync-status.error {
    color: #c0392b;
  }
  .sync-state {
    font-size: 0.8rem;
    opacity: 0.7;
  }

  /* While the native camera scans, it renders *behind* the webview. Hide the
     app and make the document transparent so the camera feed shows through; the
     teleported overlay below stays visible because it lives outside #app. */
  :global(html.qr-scanning),
  :global(html.qr-scanning body) {
    background: transparent !important;
  }
  :global(html.qr-scanning #app) {
    display: none !important;
  }

  .qr-scan-overlay {
    position: fixed;
    inset: 0;
    z-index: 2000;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
    padding: env(safe-area-inset-top) 1.5rem env(safe-area-inset-bottom);
    pointer-events: none;
  }
  .qr-scan-reticle {
    width: min(70vw, 260px);
    aspect-ratio: 1;
    border: 3px solid rgba(255, 255, 255, 0.92);
    border-radius: 18px;
    box-shadow: 0 0 0 100vmax rgba(0, 0, 0, 0.35);
  }
  .qr-scan-hint {
    margin: 0;
    max-width: 22rem;
    text-align: center;
    color: #fff;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.8);
    font-size: 0.95rem;
  }
  .qr-scan-cancel {
    pointer-events: auto;
    background: rgba(0, 0, 0, 0.55);
    color: #fff;
    border: 1px solid rgba(255, 255, 255, 0.5);
    padding: 0.6rem 1.4rem;
    border-radius: 999px;
  }
</style>
