<script lang="ts">
  import { invoke } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'

  export let refreshKey = 0
  type Status = {
    totalRecords: number; pendingRecords: number; compressedRecords: number; dictionaryRecords: number
    originalBytes: number; storedBytes: number; dictionaryBytes: number
    dictionaryCount: number; activeDictionaries: number
    lastCheckAtMs: number | null; nextCheckAtMs: number | null
  }
  let status: Status | null = null
  let busy = false
  let error = ''
  let mounted = false
  let request = 0
  let timer: ReturnType<typeof setTimeout> | undefined
  $: saved = status ? status.originalBytes - status.storedBytes - status.dictionaryBytes : 0
  $: percent = status?.originalBytes ? (100 * saved / status.originalBytes).toFixed(1) : '0.0'
  $: { refreshKey; if (mounted) void refresh() }

  onMount(() => {
    mounted = true
    return () => { mounted = false; request++; clearTimeout(timer) }
  })

  async function refresh() {
    const token = ++request
    clearTimeout(timer)
    busy = true
    error = ''
    try {
      const next = await invoke<Status>('get_list_storage_status')
      if (token !== request) return
      status = next
      // Poll only while migration is unfinished and this panel is open.
      if (next?.pendingRecords) timer = setTimeout(() => { void refresh() }, 15_000)
    } catch (reason) {
      if (token === request) { status = null; error = String(reason) }
    } finally {
      if (token === request) busy = false
    }
  }

  function bytes(value: number): string {
    if (value < 1024) return `${value} B`
    const units = ['KiB', 'MiB', 'GiB']
    let amount = value / 1024
    let unit = 0
    while (amount >= 1024 && unit < units.length - 1) { amount /= 1024; unit++ }
    return `${amount.toFixed(2)} ${units[unit]}`
  }
  function date(value: number | null): string {
    return value === null ? 'Not scheduled' : new Date(value).toLocaleString()
  }
</script>

<section aria-label="Daily list compression" class="list-storage-diagnostics">
  <div class="heading">
    <h3>Daily list compression</h3>
    <button type="button" class="ghost" disabled={busy} on:click={() => { void refresh() }} aria-label="Refresh list compression">
      {busy ? 'Measuring…' : 'Refresh'}
    </button>
  </div>
  {#if error}
    <p role="alert">Could not measure list compression: {error}</p>
  {:else if status}
    <p class="saving" role="status">
      {#if !status.totalRecords}No daily lists stored yet.
      {:else if saved >= 0}{bytes(saved)} saved ({percent}% smaller), including dictionary storage.
      {:else}{bytes(-saved)} more than uncompressed list data, including dictionary storage.{/if}
    </p>
    <dl>
      <dt>Uncompressed list data</dt><dd>{bytes(status.originalBytes)}</dd>
      <dt>Stored list data</dt><dd>{bytes(status.storedBytes)}</dd>
      <dt>Dictionary storage</dt><dd>{bytes(status.dictionaryBytes)}</dd>
      <dt>Migration</dt><dd>{status.totalRecords - status.pendingRecords} / {status.totalRecords} lists checked{status.pendingRecords ? ` · ${status.pendingRecords} remaining` : ' · complete'}</dd>
      <dt>Compressed lists</dt><dd>{status.compressedRecords} / {status.totalRecords} · {status.dictionaryRecords} using shared dictionaries</dd>
      <dt>Dictionaries</dt><dd>{status.activeDictionaries} active · {status.dictionaryCount - status.activeDictionaries} retained for history or awaiting cleanup</dd>
      <dt>Latest dictionary setup/check</dt><dd>{date(status.lastCheckAtMs)}</dd>
      <dt>Next eligible check</dt><dd>{date(status.nextCheckAtMs)}{status.nextCheckAtMs !== null && status.nextCheckAtMs <= Date.now() ? ' · waiting for idle maintenance' : ''}</dd>
    </dl>
    {#if status.pendingRecords}<p>Keep Balance visible and idle to finish migration. Progress refreshes every 15 seconds while this panel is open.</p>{/if}
    <p>Small or incompressible lists can remain uncompressed after migration. Checks run every 90 days; a replacement needs at least 20% better compression and enough projected savings to cover its cost within six months.</p>
    <p>These are list payload savings after dictionary cost, not total database-file savings or the dictionary’s benefit over ordinary compression. Indexes, history and checkpoints are excluded. Use Optimize database to reclaim unused file space.</p>
  {:else}<p>{busy ? 'Measuring list compression…' : 'No statistics available.'}</p>{/if}
</section>

<style>
  .list-storage-diagnostics { padding: 12px 0; border-bottom: 1px solid var(--border); }
  .heading { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
  h3 { margin: 0; font-size: 1rem; }
  p { font-size: 0.85rem; opacity: 0.8; }
  .saving { opacity: 1; font-weight: 600; }
  dl { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 8px 16px; font-size: 0.85rem; }
  dt { opacity: 0.75; }
  dd { margin: 0; overflow-wrap: anywhere; }
</style>
