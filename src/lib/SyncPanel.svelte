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
    syncAnonymousDiagnostics,
    saveExportFile,
    plannerStore,
  } from './store'
  import { automaticSyncStatus, requestSync } from './syncScheduler'
  import { getLastRenderedPlanSnapshot } from './renderedPlanDiagnostics'

  // Camera QR scanning is mobile-only (native plugin); on desktop you paste.
  const isMobile = /android|iphone|ipad|ipod/i.test(navigator.userAgent)

  let syncEnabled = false
  let pairingCode = ''
  let relayUrl = ''
  let qrDataUrl = ''
  let joinInput = ''
  let status = ''
  let settingsLoading = true
  let settingsLoadFailed = false
  let isError = false
  let scanning = false
  let copyLabel = 'Copy code'
  let copyTimer: ReturnType<typeof setTimeout> | undefined
  let syncingTimer: ReturnType<typeof setTimeout> | undefined
  let showSyncing = false
  let diagnosticBusy = false
  let diagnosticPath = ''

  let flow: 'choose' | 'create' | 'join' | 'review' = 'choose'
  let savedRelayUrl = ''
  let showPairing = false
  let replacementRelayUrl = ''
  let replaceKey = false
  let connectionOpen = false
  $: configured = syncEnabled && Boolean(pairingCode && savedRelayUrl)
  $: busy = actionBusy || $automaticSyncStatus.running
  $: updateSyncingIndicator($automaticSyncStatus.running)
  let actionBusy = false

  function updateSyncingIndicator(running: boolean) {
    if (!running) {
      clearTimeout(syncingTimer)
      syncingTimer = undefined
      showSyncing = false
    } else if (syncingTimer === undefined && !showSyncing) {
      // Quick background syncs should only update the last-success time.
      syncingTimer = setTimeout(() => { showSyncing = true }, 1_000)
    }
  }

  onMount(async () => {
    try {
      const settings = await getSyncSettings()
      syncEnabled = settings.enabled
      pairingCode = settings.pairingCode ?? ''
      savedRelayUrl = relayUrl = settings.relayUrl
    } catch (err) {
      syncEnabled = false
      settingsLoadFailed = true
      setStatus(`Could not load sync settings: ${err}`, true)
    } finally {
      settingsLoading = false
    }
  })

  onDestroy(() => {
    if (copyTimer) clearTimeout(copyTimer)
    clearTimeout(syncingTimer)
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
    if (busy || !validServer()) return
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
      reviewJoin()
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

  function choose(next: 'create' | 'join') {
    flow = next
    status = ''
    joinInput = ''
  }

  function validServer(value = relayUrl): boolean {
    try {
      const url = new URL(value.trim())
      if (!['https:', 'http:'].includes(url.protocol)) throw new Error()
      return true
    } catch {
      setStatus('Enter a complete sync server address, starting with https://.', true)
      return false
    }
  }

  async function persistServer() {
    const settings = await setSyncRelayUrl(relayUrl.trim())
    savedRelayUrl = relayUrl = settings.relayUrl
  }

  async function revealPairing() {
    showPairing = !showPairing
    if (showPairing) await renderQr()
  }

  async function generate() {
    const server = replaceKey ? replacementRelayUrl : relayUrl
    if (busy || !validServer(server)) return
    if (replaceKey && server.trim().replace(/\/+$/, '') === savedRelayUrl.replace(/\/+$/, '')) {
      setStatus('Use a new, empty sync server for the new key.', true)
      return
    }
    actionBusy = true
    try {
      const newPairingCode = await syncNewPairingCode()
      const settings = await syncEnablePrimary(newPairingCode, server.trim())
      savedRelayUrl = relayUrl = settings.relayUrl
      pairingCode = newPairingCode
      syncEnabled = true
      flow = 'choose'
      replaceKey = false
      showPairing = true
      await renderQr()
      const result = await requestSync('sync-enabled')
      setStatus(result ? 'Setup complete. You can now connect your other device.' : 'Setup saved. The first sync has not completed; Balance will retry automatically.', !result)
    } catch (err) {
      setStatus(`Could not set up sync: ${err}`, true)
    } finally {
      actionBusy = false
    }
  }

  function reviewJoin() {
    if (!validServer()) return
    if (!joinInput.trim().startsWith('BALSYNC1:')) {
      setStatus('That does not look like a Balance pairing code.', true)
      return
    }
    status = ''
    flow = 'review'
  }

  async function join() {
    if (busy || flow !== 'review' || !validServer()) return
    actionBusy = true
    try {
      const code = joinInput.trim()
      const settings = await syncEnableJoiner(code, relayUrl.trim())
      savedRelayUrl = relayUrl = settings.relayUrl
      pairingCode = code
      joinInput = ''
      syncEnabled = true
      flow = 'choose'
      showPairing = false
      await plannerStore.reloadFromBackend()
      const result = await requestSync('paired')
      setStatus(result ? 'Connected. This device now syncs automatically.' : 'Connection saved. Waiting for the first sync; Balance will retry automatically.', !result)
    } catch (err) {
      setStatus(`Could not connect: ${err}`, true)
    } finally {
      actionBusy = false
    }
  }

  async function saveRelay() {
    if (busy || !validServer()) return
    actionBusy = true
    try {
      await persistServer()
      const result = await requestSync('relay-configured')
      setStatus(result ? 'Connected to sync server.' : 'Server address saved. Sync has not completed; Balance will retry automatically.', !result)
    } catch (err) {
      setStatus(`Could not save sync server: ${err}`, true)
    } finally {
      actionBusy = false
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
    if (busy || !configured) return
    actionBusy = true
    try {
      const result = await requestSync('manual')
      setStatus(result ? 'Sync complete.' : 'Could not sync. Balance will retry automatically.', !result)
    } catch (err) {
      setStatus(`Could not sync: ${err}`, true)
    } finally {
      actionBusy = false
    }
  }

  async function exportAnonymousDiagnostics() {
    diagnosticBusy = true
    diagnosticPath = ''
    try {
      const content = await syncAnonymousDiagnostics(
        JSON.stringify($plannerStore),
        JSON.stringify(getLastRenderedPlanSnapshot()),
      )
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
      diagnosticPath = await saveExportFile(`balance-recent-anonymous-sync-trace-${timestamp}.json`, content)
      setStatus('Recent anonymous sync trace saved. Export one on your other device too, then compare the two files.')
    } catch (err) {
      setStatus(`Could not export anonymous sync trace: ${err}`, true)
    } finally {
      diagnosticBusy = false
    }
  }

</script>

<section class="settings-section sync-panel">
  <div>
    <h3>Sync across your devices</h3>
    <p>Keep your planner in sync over the internet. Your data stays end-to-end encrypted.</p>
  </div>

  <div class="sync-body">
    {#if settingsLoading}
      <p role="status">Loading sync settings…</p>
    {:else if settingsLoadFailed}
      <p role="alert">Sync settings are unavailable. Close and reopen Settings to try again.</p>
    {:else}
      {#if !syncEnabled || !pairingCode || flow !== 'choose'}
        {#if flow === 'choose'}
          <div class="sync-choices">
            <button type="button" class="sync-choice" on:click={() => choose('create')} disabled={busy}>
              <strong>Set up sync from this device</strong>
              <span>Start here on the device with your existing planner.</span>
            </button>
            <button type="button" class="sync-choice" on:click={() => choose('join')} disabled={busy}>
              <strong>Connect to an existing setup</strong>
              <span>Get a code from a device you already use.</span>
            </button>
          </div>
          <p class="sync-hosting">Sync is self-hosted for now: you’ll need your own sync server. We’re looking to add a hosted service if enough people request it.</p>
        {:else if flow === 'review'}
          <div class="sync-card">
            <h4>Use your existing synced planner?</h4>
            <p>This device’s planner will be replaced with the planner from your existing sync setup. Balance backs up this device’s current data first. The two planners won’t be combined.</p>
            <p>Keep Balance open while the first sync finishes.</p>
            <div class="sync-actions">
              <button type="button" class="primary" on:click={join} disabled={busy}>Connect and replace this planner</button>
              <button type="button" class="ghost" on:click={() => flow = 'join'} disabled={busy}>Back</button>
            </div>
          </div>
        {:else}
          <form class="sync-card" on:submit|preventDefault={flow === 'create' ? generate : reviewJoin}>
            <h4>{flow === 'create' ? 'Set up sync from this device' : 'Connect to an existing setup'}</h4>
            <p>{flow === 'create' ? 'This device’s planner will be the starting point for your other devices. Use an empty sync server for a new setup.' : 'On your other device, open Settings → Sync across your devices → Connect another device.'}</p>
            <label for="sync-setup-server">Sync server address</label>
            <input id="sync-setup-server" type="url" placeholder="https://sync.example.com/your-server-path" autocomplete="off" spellcheck="false" bind:value={relayUrl} disabled={busy} required />
            <p class="sync-hosting">{flow === 'join' ? 'Use the same full server address as your other device. The pairing code does not include it.' : 'Sync is self-hosted for now. Enter the full address of your server, including its private path. We’re looking to add a hosted service if enough people request it.'}</p>
            {#if flow === 'join'}
              <label for="sync-join-input">Pairing code</label>
              <input id="sync-join-input" type="text" placeholder="Paste the code from your other device" autocomplete="off" spellcheck="false" bind:value={joinInput} disabled={busy} />
              {#if isMobile}
                <button type="button" on:click={scanCode} disabled={busy || scanning || !relayUrl.trim()}>Scan QR code</button>
              {/if}
            {/if}
            <div class="sync-actions">
              <button type="submit" class="primary" disabled={busy || !relayUrl.trim() || (flow === 'join' && !joinInput.trim())}>{flow === 'create' ? 'Set up sync' : 'Continue'}</button>
              <button type="button" class="ghost" on:click={() => { flow = 'choose'; status = '' }} disabled={busy}>Back</button>
            </div>
          </form>
        {/if}
      {:else}
        <div class="sync-card sync-overview" role="status" aria-live="polite">
          <strong>
            {#if !configured}Setup incomplete
            {:else if $automaticSyncStatus.offline}You’re offline
            {:else if showSyncing}Syncing…
            {:else if $automaticSyncStatus.lastError}Sync needs attention
            {:else if $automaticSyncStatus.pending}Changes waiting to sync
            {:else if $automaticSyncStatus.lastSuccessAt}Connected to sync server
            {:else}Waiting for first sync{/if}
          </strong>
          <p>
            {#if !configured}Add your sync server address below to finish setup.
            {:else if $automaticSyncStatus.offline}Your changes are saved on this device. Sync will retry when you’re online.
            {:else if $automaticSyncStatus.lastError}Your changes are saved on this device. Balance will retry automatically.
            {:else}Changes sync automatically. Other devices receive them when they connect.{/if}
          </p>
          {#if configured && $automaticSyncStatus.lastSuccessAt}
            <p class="sync-state">Last successful sync: {new Date($automaticSyncStatus.lastSuccessAt).toLocaleString()}.</p>
          {/if}
        </div>
        <div class="sync-actions">
          <button type="button" class="primary" on:click={revealPairing} disabled={busy || !configured} aria-expanded={showPairing}>Connect another device</button>
          <button type="button" on:click={syncNow} disabled={busy || !configured}>Sync now</button>
        </div>
        {#if showPairing && configured}
          <div class="sync-card">
            <h4>Connect your other device</h4>
            <p>Open Balance on your other device and choose Settings → Sync across your devices → Connect to an existing setup.</p>
            <p>Enter the same sync server address, then scan this QR code or paste the pairing code.</p>
            <div class="sync-pairing">
              {#if qrDataUrl}<img class="sync-qr" src={qrDataUrl} alt="Pairing QR code" />{/if}
              <div class="sync-code-block">
                <button type="button" on:click={copyCode}>{copyLabel}</button>
                <details><summary>Show pairing code</summary><code class="sync-code">{pairingCode}</code></details>
              </div>
            </div>
            <p class="sync-state">Keep this code private. It gives another device access to your synced planner.</p>
          </div>
        {/if}
        <details class="sync-details" open={!configured || connectionOpen} on:toggle={(event) => connectionOpen = event.currentTarget.open}>
          <summary>Connection settings</summary>
          <form class="sync-card" on:submit|preventDefault={saveRelay}>
            <label for="sync-relay-input">Sync server address</label>
            <input id="sync-relay-input" type="url" placeholder="https://sync.example.com/your-server-path" autocomplete="off" spellcheck="false" bind:value={relayUrl} disabled={busy} required />
            <p class="sync-hosting">Sync is self-hosted for now. Use the same full server address on all your devices. We’re looking to add a hosted service if enough people request it.</p>
            <button type="submit" disabled={busy || !relayUrl.trim()}>Save and connect</button>
          </form>
          <button type="button" class="ghost" on:click={() => choose('join')} disabled={busy}>Connect to a different setup</button>
        </details>
        <details class="sync-details">
          <summary>Troubleshooting</summary>
          <div class="sync-card">
            <p>Check that each device uses the same sync server address and pairing code. Keep Balance open during the first sync.</p>
            {#if $automaticSyncStatus.lastError}<p class="sync-status error">{$automaticSyncStatus.lastError}</p>{/if}
      <div class="sync-diagnostics">
        <strong>Recent anonymous sync diagnostics</strong>
        <p>
          Exports recent sync activity and anonymous task details to help troubleshoot
          differences between devices. Includes task order, nesting, completion state,
          and whether content matches, without revealing task text.
        </p>
        <div class="sync-actions">
          <button type="button" on:click={exportAnonymousDiagnostics} disabled={busy || diagnosticBusy}>
            {diagnosticBusy ? 'Preparing trace…' : 'Export recent anonymous sync trace'}
          </button>
          {#if diagnosticPath}
            <span class="sync-state">Saved to {diagnosticPath}</span>
          {/if}
        </div>
      </div>
            <details>
              <summary>Advanced: replace sync key</summary>
              <p>Starts a new sync setup using this device’s current planner. Your other devices will need to connect again with the new code.</p>
              {#if replaceKey}
                <p>Use this device’s planner as the starting point for the new setup? First set up a new, empty sync server. The existing server contains data encrypted with the old key.</p>
                <label for="sync-replacement-server">New sync server address</label>
                <input id="sync-replacement-server" type="url" placeholder="https://sync.example.com/new-server-path" autocomplete="off" spellcheck="false" bind:value={replacementRelayUrl} disabled={busy} />
                <div class="sync-actions">
                  <button type="button" on:click={generate} disabled={busy || !configured || !replacementRelayUrl.trim()}>Replace key and start new setup</button>
                  <button type="button" class="ghost" on:click={() => replaceKey = false} disabled={busy}>Cancel</button>
                </div>
              {:else}
                <button type="button" on:click={() => replaceKey = true} disabled={busy || !configured}>Replace sync key…</button>
              {/if}
            </details>
          </div>
        </details>
      {/if}
    {/if}
    {#if status}<p class="sync-status" class:error={isError} role="status" aria-live="polite">{status}</p>{/if}
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
    min-width: 0;
    flex: 1;
  }
  .sync-code {
    display: block;
    font-family: var(--font-mono);
    font-size: 0.78rem;
    word-break: break-all;
    padding: 0.5rem 0.6rem;
    border-radius: 6px;
    background: rgba(127, 127, 127, 0.12);
  }
  .sync-card, .sync-diagnostics, .sync-choices {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: 0;
  }
  .sync-card, .sync-choice {
    padding: 1rem;
    border: 1px solid var(--line);
    border-radius: 10px;
  }
  .sync-choice { display: flex; flex-direction: column; gap: 0.4rem; text-align: left; }
  .sync-choice span, .sync-hosting { font-size: 0.85rem; line-height: 1.5; opacity: 0.8; }
  .sync-card h4, .sync-card p { margin: 0; }
  .sync-card input { width: 100%; min-width: 0; box-sizing: border-box; }
  .sync-card > button { align-self: flex-start; }
  .sync-details { border-top: 1px solid var(--line); padding-top: 0.85rem; }
  summary { cursor: pointer; padding: 0.35rem 0; }
  details[open] > summary { margin-bottom: 0.65rem; }
  .sync-overview { background: var(--paper); }
  .sync-status, .sync-code { overflow-wrap: anywhere; }
  @media (max-width: 480px) { .sync-pairing { flex-direction: column; align-items: flex-start; } }
  .sync-actions {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .sync-status {
    margin: 0;
    font-size: 0.85rem;
  }
  .sync-status.error {
    color: var(--danger);
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
