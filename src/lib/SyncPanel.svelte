<script lang="ts">
  import { onMount } from 'svelte'
  import QRCode from 'qrcode'
  import {
    syncStatus,
    syncNewPairingCode,
    syncEnablePrimary,
    syncEnableJoiner,
    syncPullSealed,
    syncApplySealed,
  } from './store'

  // The pairing code IS the end-to-end key (encoded). It is held only on the
  // user's devices; the relay never sees it. Persisted in localStorage so the
  // device remembers its account between launches.
  const STORAGE_KEY = 'balance.sync.pairingCode'
  const RELAY_KEY = 'balance.sync.relayUrl'

  let migrated = false
  let pairingCode = ''
  let relayUrl = ''
  let qrDataUrl = ''
  let joinInput = ''
  let status = ''
  let busy = false
  let isError = false

  onMount(async () => {
    pairingCode = localStorage.getItem(STORAGE_KEY) ?? ''
    relayUrl = localStorage.getItem(RELAY_KEY) ?? ''
    try {
      migrated = await syncStatus()
    } catch {
      migrated = false
    }
    if (pairingCode) await renderQr()
  })

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
      pairingCode = await syncNewPairingCode()
      localStorage.setItem(STORAGE_KEY, pairingCode)
      // This device becomes the source of truth; its data is snapshotted into
      // the synced log (and backed up first).
      await syncEnablePrimary()
      migrated = true
      await renderQr()
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
    try {
      pairingCode = code
      localStorage.setItem(STORAGE_KEY, pairingCode)
      joinInput = ''
      // Joining adopts the other device's data; this device's current data is
      // backed up and replaced on the next sync.
      await syncEnableJoiner()
      migrated = true
      await renderQr()
      setStatus('Paired. Tap "Sync now" to pull your data from the other device.')
    } catch (err) {
      setStatus(`Could not pair: ${err}`, true)
    } finally {
      busy = false
    }
  }

  function saveRelay() {
    localStorage.setItem(RELAY_KEY, relayUrl.trim())
    setStatus('Relay server saved.')
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(pairingCode)
      setStatus('Pairing code copied.')
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
      const sealed = await syncPullSealed(pairingCode, 0)
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
        const newState = await syncApplySealed(pairingCode, Uint8Array.from(env))
        if (newState) applied += 1
      }
      migrated = true
      setStatus(`Synced. Applied ${applied} update(s) from the server.`)
      if (applied > 0) {
        // Reload so the rebuilt state shows immediately.
        setTimeout(() => location.reload(), 600)
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
            <button type="button" on:click={copyCode}>Copy code</button>
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
      <p>Paste the pairing code shown on your other device.</p>
      <div class="sync-actions">
        <input
          id="sync-join-input"
          type="text"
          placeholder="BALSYNC1:…"
          spellcheck="false"
          bind:value={joinInput}
        />
        <button type="button" on:click={join} disabled={busy || !joinInput.trim()}>Pair</button>
      </div>
    </div>

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
        <button type="button" on:click={saveRelay}>Save</button>
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
  .sync-relay {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
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
</style>
