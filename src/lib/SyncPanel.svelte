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
    syncNewPairingCode,
    syncEnablePrimary,
    syncEnableJoiner,
    syncP2pServe,
    syncP2pPeers,
    syncP2pSync,
    auditLegacyMigrationReadiness,
    stageLegacySyncCleanup,
    finalizeLegacySyncCleanup,
    plannerStore,
    type LegacyMigrationAuditResult,
    type SyncPeer,
  } from './store'
  import { automaticSyncStatus, requestSync } from './syncScheduler'

  // Camera QR scanning is mobile-only (native plugin); on desktop you paste.
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent)

  let migrated = false
  let pairingCode = ''
  let relayUrl = ''
  let qrDataUrl = ''
  let joinInput = ''
  let status = ''
  let busy = false
  let settingsLoading = true
  let settingsLoadFailed = false
  let pairing = false
  let isError = false
  let scanning = false
  let copyLabel = 'Copy code'
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let auditBusy = false
  let auditResult: LegacyMigrationAuditResult | null = null
  let auditError = ''
  let cleanupBusy = false
  let cleanupMessage = ''

  let localAddress = ''
  let peers: SyncPeer[] = []
  let peerAddress = ''
  let peerPoll: ReturnType<typeof setInterval> | undefined

  onMount(async () => {
    try {
      const settings = await getSyncSettings()
      migrated = settings.enabled
      pairingCode = settings.pairingCode ?? ''
      relayUrl = settings.relayUrl
    } catch (err) {
      migrated = false
      settingsLoadFailed = true
      setStatus(`Could not load sync settings: ${err}`, true)
    } finally {
      settingsLoading = false
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
      if (relayUrl) await requestSync('sync-enabled')
      setStatus('Sync enabled and automatic. Scan or paste this code on your other device to join.')
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
      if (relayUrl) await requestSync('paired')
      setStatus(
        relayUrl
          ? 'Paired. Relay changes now sync automatically.'
          : 'Paired. Use a device below to sync directly, or configure a relay.',
      )
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
      if (relayUrl && pairingCode) await requestSync('relay-configured')
      setStatus(relayUrl ? 'Relay server saved. Automatic sync is active.' : 'Relay server cleared.')
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
      const result = await requestSync('manual')
      if (!result) throw new Error('The relay sync did not complete; it will retry automatically.')
      migrated = true
      const checkpoint = result.checkpointCommitted ? ' Relay storage was compacted.' : ''
      setStatus(
        `Synced ${result.pushedOperations} outgoing and ${result.pulledOperations} incoming operation(s).${checkpoint}`,
      )
    } catch (err) {
      setStatus(`Sync failed: ${err}`, true)
    } finally {
      busy = false
    }
  }

  async function runMigrationAudit() {
    auditBusy = true
    auditResult = null
    auditError = ''
    try {
      auditResult = await auditLegacyMigrationReadiness()
      if (!auditResult) auditError = 'The audit is available only in the Balance app.'
    } catch (err) {
      auditError = `Audit failed: ${err}`
    } finally {
      auditBusy = false
    }
  }

  function auditCheckPassed(id: string) {
    return auditResult?.checks.find((check) => check.id === id)?.passed ?? false
  }

  function canFinalizeMigrationCleanup() {
    if (!auditResult || auditCheckPassed('local-cleanup-guard')) return false
    return auditResult.checks.every(
      (check) =>
        check.passed ||
        check.id === 'local-cleanup-guard' ||
        check.id === 'relay-rollback-generation',
    )
  }

  async function stageMigrationCleanup() {
    cleanupBusy = true
    cleanupMessage = ''
    auditError = ''
    try {
      const result = await stageLegacySyncCleanup()
      if (!result) throw new Error('The cleanup is available only in the Balance app.')
      cleanupMessage = result.message
      auditResult = await auditLegacyMigrationReadiness()
    } catch (err) {
      auditError = `Cleanup failed safely: ${err}`
    } finally {
      cleanupBusy = false
    }
  }

  async function finalizeMigrationCleanup() {
    const guardedIds = auditResult?.checks
      .find((check) => check.id === 'local-cleanup-guard')
      ?.detail.match(/\d+/)?.[0] ?? 'the'
    const confirmed = window.confirm(
      `Finalize migration cleanup now?\n\nContinue only if every active Balance installation says it is safely staged. This immediately replaces the old relay rollback generation and permanently removes ${guardedIds} guarded retired IDs from this installation. A forgotten offline installation could reintroduce retired data.`,
    )
    if (!confirmed) return

    cleanupBusy = true
    cleanupMessage = ''
    auditError = ''
    try {
      const result = await finalizeLegacySyncCleanup()
      if (!result) throw new Error('Finalization is available only in the Balance app.')
      cleanupMessage = result.message
      auditResult = await auditLegacyMigrationReadiness()
    } catch (err) {
      auditError = `Finalization failed safely: ${err}`
    } finally {
      cleanupBusy = false
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
      {#if settingsLoading}
        <p class="sync-state" role="status" aria-live="polite">Loading sync settings…</p>
      {:else if settingsLoadFailed}
        <p class="sync-state">Sync settings are unavailable.</p>
      {:else}
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
      {/if}
    </div>

    <div class="sync-actions">
      <button class="primary" type="button" on:click={syncNow} disabled={busy}>
        {busy ? 'Syncing…' : 'Sync now'}
      </button>
      <span class="sync-state" aria-live="polite">
        {#if $automaticSyncStatus.running}
          Automatic sync is running…
        {:else if $automaticSyncStatus.lastError}
          Automatic sync will retry: {$automaticSyncStatus.lastError}
        {:else if $automaticSyncStatus.lastSuccessAt}
          Last automatically synced at {new Date($automaticSyncStatus.lastSuccessAt).toLocaleTimeString()}.
        {:else}
          {migrated ? 'Automatic sync is ready on this device.' : 'Not yet synced.'}
        {/if}
      </span>
    </div>

    {#if status}
      <p class="sync-status" class:error={isError} aria-live="polite">{status}</p>
    {/if}

    <div class="migration-audit">
      <div>
        <h4>Temporary migration cleanup audit</h4>
        <p>
          Checks this encrypted database and the current relay generation in place. Relay
          ciphertext is decrypted only in memory; no data is exported or changed.
        </p>
      </div>
      <button type="button" on:click={runMigrationAudit} disabled={busy || auditBusy || cleanupBusy}>
        {auditBusy ? 'Auditing…' : 'Run removal audit'}
      </button>

      {#if auditError}
        <p class="audit-summary error" role="alert">{auditError}</p>
      {:else if auditResult}
        <p
          class="audit-summary"
          class:ready={auditResult.readyOnThisInstallation}
          class:error={!auditResult.readyOnThisInstallation}
          aria-live="polite"
        >
          {#if auditResult.readyOnThisInstallation}
            Ready on this installation and relay. Run this audit on every active Balance
            installation; when all of them pass, the legacy compatibility code can be removed.
          {:else if !auditCheckPassed('local-cleanup-guard')}
            This installation is safely staged. Once every active installation is staged, you can
            finalize immediately without waiting for the rollback window.
          {:else}
            Not ready yet. Resolve the failed checks below, then run the audit again.
          {/if}
        </p>
        {#if auditCheckPassed('local-cleanup-guard') && (!auditCheckPassed('local-checkpoints') || !auditCheckPassed('local-tombstones'))}
          <div class="cleanup-action">
            <p>
              Clean this installation and promote a current-format relay checkpoint. Retired
              operation ids remain in a temporary safety guard, so an installation cleaned later
              cannot resurrect them.
            </p>
            <button type="button" on:click={stageMigrationCleanup} disabled={busy || auditBusy || cleanupBusy}>
              {cleanupBusy ? 'Cleaning safely…' : 'Clean this installation'}
            </button>
          </div>
        {/if}
        {#if !auditCheckPassed('local-cleanup-guard') && !auditCheckPassed('relay-checkpoints')}
          <button type="button" on:click={stageMigrationCleanup} disabled={busy || auditBusy || cleanupBusy}>
            {cleanupBusy ? 'Retrying safely…' : 'Retry relay cleanup'}
          </button>
        {/if}
        {#if canFinalizeMigrationCleanup()}
          <div class="cleanup-action">
            <p>
              If every active Balance installation is safely staged, replace the old rollback
              generation with another verified current-format checkpoint and remove this
              installation's temporary guard now.
            </p>
            <button type="button" on:click={finalizeMigrationCleanup} disabled={busy || auditBusy || cleanupBusy}>
              {cleanupBusy ? 'Finalizing safely…' : 'Finalize cleanup now'}
            </button>
          </div>
        {/if}
        {#if cleanupMessage}
          <p class="audit-summary ready" role="status">{cleanupMessage}</p>
        {/if}
        <ul class="audit-checks">
          {#each auditResult.checks as check (check.id)}
            <li class:passed={check.passed} class:failed={!check.passed}>
              <span class="audit-icon" aria-hidden="true">{check.passed ? '✓' : '!'}</span>
              <span>
                <strong>{check.label}</strong>
                <small>{check.detail}</small>
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
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
    font-family: var(--font-mono);
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
    font-family: var(--font-mono);
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
  .migration-audit {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.65rem;
    margin-top: 0.5rem;
    padding: 0.85rem;
    border: 1px solid rgba(127, 127, 127, 0.25);
    border-radius: 8px;
  }
  .migration-audit h4,
  .migration-audit p {
    margin: 0;
  }
  .migration-audit h4 {
    margin-bottom: 0.25rem;
  }
  .migration-audit > div > p {
    font-size: 0.82rem;
    opacity: 0.75;
  }
  .audit-summary {
    font-size: 0.85rem;
  }
  .audit-summary.ready {
    color: #26834a;
  }
  .audit-summary.error {
    color: #c0392b;
  }
  .cleanup-action {
    width: 100%;
    padding: 0.65rem;
    border-left: 3px solid #b7791f;
    background: rgba(183, 121, 31, 0.09);
    border-radius: 4px;
  }
  .cleanup-action p {
    margin: 0 0 0.55rem;
    font-size: 0.82rem;
  }
  .audit-checks {
    width: 100%;
    list-style: none;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    margin: 0;
    padding: 0;
  }
  .audit-checks li {
    display: flex;
    align-items: flex-start;
    gap: 0.55rem;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    background: rgba(127, 127, 127, 0.08);
  }
  .audit-checks li.passed .audit-icon {
    color: #26834a;
  }
  .audit-checks li.failed .audit-icon {
    color: #c0392b;
  }
  .audit-icon {
    width: 1rem;
    flex: 0 0 1rem;
    font-weight: 700;
  }
  .audit-checks strong,
  .audit-checks small {
    display: block;
  }
  .audit-checks strong {
    font-size: 0.83rem;
  }
  .audit-checks small {
    margin-top: 0.1rem;
    font-size: 0.76rem;
    opacity: 0.72;
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
