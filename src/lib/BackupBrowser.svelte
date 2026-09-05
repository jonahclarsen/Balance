<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { onDestroy, onMount } from 'svelte'
  import { backupDocuments, type BackupContent, type BackupDocument, type DatabaseBackup } from './backupBrowser'

  let backups: DatabaseBackup[] = []
  let filename = ''
  let documents: BackupDocument[] = []
  let query = ''
  let kind = ''
  let selectedId = ''
  let busy = false
  let loaded = false
  let error = ''
  let status = ''
  let recoveryKey = ''
  let showKey = false
  let limit = 100
  let request = 0
  $: kinds = [...new Set(documents.map(document => document.kind))].sort()
  $: filtered = documents.filter(document => (!kind || document.kind === kind)
    && `${document.title}\n${document.text}`.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()))
  $: selected = filtered.find(document => document.id === selectedId) ?? filtered[0]
  $: currentIndex = backups.findIndex(backup => backup.filename === filename)
  $: { query; kind; limit = 100 }

  onMount(() => { if (isTauri()) void refresh() })
  onDestroy(() => { request++; documents = []; recoveryKey = '' })

  async function refresh() {
    const token = ++request
    busy = true
    error = ''; status = ''; loaded = false; documents = []; recoveryKey = ''; showKey = false
    try {
      const result = await invoke<DatabaseBackup[]>('list_database_backups')
      if (token !== request) return
      backups = result
      filename = backups.some(backup => backup.filename === filename) ? filename : backups[0]?.filename ?? ''
      if (filename) { await openBackup(filename); return }
    } catch (reason) {
      if (token === request) error = String(reason)
    } finally {
      if (token === request) busy = false
    }
  }

  async function openBackup(nextFilename: string, key?: string) {
    const token = ++request
    filename = nextFilename
    documents = []; selectedId = ''; status = ''; error = ''; loaded = false
    recoveryKey = ''; showKey = false; busy = true
    try {
      const content = await invoke<BackupContent>('read_database_backup', { filename, recoveryKey: key ?? null })
      if (token !== request) return
      documents = backupDocuments(content)
      loaded = true
    } catch (reason) {
      if (token !== request) return
      error = String(reason)
      showKey = true
    } finally {
      if (token === request) busy = false
    }
  }

  async function copy(document: BackupDocument) {
    const token = request
    try {
      await invoke('write_balance_clipboard', { plainText: document.text, structuredPayload: '' })
        .catch(() => navigator.clipboard.writeText(document.text))
      if (token === request) status = 'Copied to clipboard. Close recovery and paste where you want to recover this text.'
    } catch {
      if (token === request) status = 'Could not copy. Select the text below and copy it manually.'
    }
  }

  const timestamp = (backup: DatabaseBackup) => new Date(backup.createdAtMs).toLocaleString()
</script>

<section class="backup-browser" aria-label="Encrypted backup browser">
  <h3>Encrypted backups</h3>
  <p>Browse older content even after undo history expires. Backups stay encrypted on disk and open read-only.
    Copy text to recover it in your current workspace.</p>
  <p class="hint">Balance keeps the latest seven daily backups, taken after the first change each day.
    Older optimization backups also appear when available. This browser shows saved text, without images or rich formatting.</p>

  {#if !isTauri()}
    <p>Backup browsing is available in the installed Balance app.</p>
  {:else}
    <div class="controls">
      <label class="backup-picker">Backup
        <select value={filename} disabled={busy || !backups.length} on:change={event => { void openBackup(event.currentTarget.value) }}>
          {#each backups as backup}
            <option value={backup.filename}>{timestamp(backup)} · {backup.filename.startsWith('balance-daily-') ? 'Daily' : 'Optimization'} · {(backup.bytes / 1048576).toFixed(1)} MB</option>
          {/each}
        </select>
      </label>
      <button type="button" disabled={busy || currentIndex < 0 || currentIndex >= backups.length - 1} on:click={() => { void openBackup(backups[currentIndex + 1].filename) }}>Older</button>
      <button type="button" disabled={busy || currentIndex <= 0} on:click={() => { void openBackup(backups[currentIndex - 1].filename) }}>Newer</button>
      <button type="button" disabled={busy} on:click={() => { void refresh() }}>Refresh backups</button>
    </div>
    {#if filename}<p class="filename">{filename}</p>{/if}
    {#if busy}<p role="status">Opening encrypted backup…</p>{/if}
    {#if error}<p role="alert" class="error">{error}</p>{/if}
    {#if !busy && !error && !backups.length}<p>No saved backups yet. A daily backup is created after a change in the installed app.</p>{/if}
    {#if showKey}
      <form on:submit|preventDefault={() => { void openBackup(filename, recoveryKey.trim()) }}>
        <label>Original recovery key
          <input type="password" bind:value={recoveryKey} autocomplete="off" spellcheck="false" autocapitalize="off" />
        </label>
        <p class="hint">For a backup made before key rotation, use its saved key (or the archived key in Keychain on macOS).
          The key is used only for this preview.</p>
        <button type="submit" disabled={busy || !recoveryKey.trim()}>Unlock backup</button>
      </form>
    {/if}
    {#if loaded}
      <div class="controls">
        <label class="search">Search this backup<input type="search" bind:value={query} placeholder="Find missing text…" /></label>
        <label>Content<select bind:value={kind}><option value="">All content</option>{#each kinds as category}<option>{category}</option>{/each}</select></label>
      </div>
      <p class="hint">{filtered.length} matching documents</p>
      {#if status}<p role="status">{status}</p>{/if}
      <div class="documents">
        <div class="document-list" aria-label="Backup documents">
          {#each filtered.slice(0, limit) as document (document.id)}
            <button type="button" class:active={selected?.id === document.id} aria-pressed={selected?.id === document.id}
              on:click={() => { selectedId = document.id; status = '' }}><small>{document.kind}</small>{document.title}</button>
          {/each}
          {#if filtered.length > limit}<button type="button" on:click={() => { limit += 100 }}>Show more</button>{/if}
        </div>
        <div class="preview">
          {#if selected}
            <h4>{selected.title}</h4>
            <button type="button" on:click={() => { void copy(selected) }}>Copy text</button>
            <pre aria-label="Backup text">{selected.text || '(Empty document)'}</pre>
          {:else}<p>No matching content in this backup.</p>{/if}
        </div>
      </div>
    {/if}
  {/if}
</section>

<style>
  .backup-browser { min-width: 0; padding-bottom: 20px; }
  h3, h4 { margin: 0 0 10px; }
  p { line-height: 1.5; }
  .hint, small, .filename { color: var(--muted); font-size: 12px; }
  .filename { overflow-wrap: anywhere; }
  .controls { display: flex; align-items: end; gap: 8px; flex-wrap: wrap; }
  label { display: flex; flex-direction: column; gap: 6px; font-size: 12px; min-width: 0; }
  .backup-picker, .search { flex: 1 1 220px; }
  input, select { width: 100%; min-width: 0; box-sizing: border-box; }
  .documents { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(0, 2fr); gap: 16px; }
  .document-list { display: flex; flex-direction: column; gap: 6px; max-height: 420px; overflow: auto; }
  .document-list button { text-align: left; overflow-wrap: anywhere; flex-shrink: 0; }
  small { display: block; margin-bottom: 4px; }
  .active { outline: 2px solid var(--accent); outline-offset: -2px; }
  .preview { min-width: 0; }
  pre { white-space: pre-wrap; overflow-wrap: anywhere; max-height: 420px; overflow: auto; font: inherit; line-height: 1.6; user-select: text; -webkit-user-select: text; }
  .error { color: var(--danger, #b84040); }
  @media (max-width: 600px) { .documents { grid-template-columns: minmax(0, 1fr); } .document-list { max-height: 180px; } }
</style>
