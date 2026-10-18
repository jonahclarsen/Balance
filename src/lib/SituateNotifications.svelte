<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'
  import { situate } from './situate/store'
  import OverlayModal from './OverlayModal.svelte'
  type Row = { id:number; app:string; appName?:string; blockedModes?:string[]; title:string; text:string; received:number; opened:number; modes:string[] }
  let rows: Row[] = []
  let apps: {id:string;name:string;count:number}[] = []
  onMount(() => { void load() })
  let search = '', app = '', mode = '', sort = 'received', range = 'all', error = ''
  let blocked = false, busy = false, more = false, confirmClear = false, confirmExport = false
  let request = 0
  async function load(append = false) {
    const token = ++request; busy = true; error = ''
    const last = append ? rows.at(-1) : undefined
    try {
      const result = await invoke<{ rows:Row[]; hasMore:boolean; apps:typeof apps }>('situate_notifications', { action:'list', query:{ search,app,mode,blocked,sort, since:range === 'all' ? 0 : Date.now()-Number(range)*86400000, before: last ? sort === 'opened' ? last.opened : last.received : undefined, beforeId:last?.id } })
      if (token === request) { rows = append ? [...rows,...result.rows] : result.rows; more = result.hasMore; apps = result.apps }
    } catch(e) { if(token === request) error=String(e) } finally { if(token === request) busy=false }
  }
  async function action(name:string, query:object = {}) { try { await invoke('situate_notifications',{ action:name,query }); if(name==='delete-all') { rows=[]; more=false }; error='' } catch(e) { error=String(e) } }
</script>
<section class="archive"><h2>Notification history</h2><p class="muted">Stored only on this phone. Search whole words. “Opened here” records when you opened an entry below, not when you read it elsewhere. If an original notification action has expired, its app opens instead.</p>
<form on:submit|preventDefault={() => load()}><label>Search<input bind:value={search} type="search" /></label><label>App<select bind:value={app}><option value="">All apps</option>{#each apps as entry}<option value={entry.id}>{entry.name} ({entry.count})</option>{/each}</select></label>
<label>Mode<select bind:value={mode}><option value="">All modes</option>{#each $situate.modes as m}<option value={m.id}>{m.name}</option>{/each}</select></label><label>Sort<select bind:value={sort}><option value="received">Recently received</option><option value="opened">Recently opened here</option></select></label><label>When<select bind:value={range}><option value="all">Any time</option><option value="1">Last day</option><option value="7">Last week</option><option value="30">Last month</option></select></label><label class="check"><input type="checkbox" bind:checked={blocked} />Blocked notifications only</label><button disabled={busy} type="submit">Search notifications</button></form>
{#if error}<p role="alert">{error}</p>{/if}
<div class="notification-list">{#each rows as row (row.id)}<button class="notification" type="button" on:click={() => action('open',{ id:row.id })}><span>{row.appName || row.app} · {new Date(row.received).toLocaleString()}</span><strong>{row.title}</strong><span>{row.text}</span>{#if (row.blockedModes ?? []).length}<small>Blocked by {row.blockedModes?.join(', ')}</small>{/if}</button>{/each}</div>
{#if more}<button disabled={busy} type="button" on:click={() => load(true)}>Load more</button>{/if}
<div class="actions"><button type="button" on:click={() => confirmExport=true}>Export notifications</button><button type="button" on:click={() => confirmClear=true}>Delete all history</button></div></section>
{#if confirmClear}<OverlayModal title="Delete notification history?" onClose={() => confirmClear=false}><p>This removes the encrypted history from this phone.</p><button type="button" on:click={() => { confirmClear=false; void action('delete-all') }}>Delete all history</button></OverlayModal>{/if}
{#if confirmExport}<OverlayModal title="Export notification history" onClose={() => confirmExport=false}><p>The exported file contains readable notification text. Choose a private destination; a cloud-backed folder will upload it.</p><button type="button" on:click={() => { confirmExport=false; void action('export') }}>Choose destination</button></OverlayModal>{/if}
<style>.archive { margin-top:32px; } form { display:flex; flex-wrap:wrap; gap:12px; align-items:end; } label { display:grid; gap:6px; } .check { display:flex; align-items:center; min-height:44px; } .notification-list { display:grid; gap:8px; margin:20px 0; } .notification { display:grid; gap:6px; text-align:left; padding:14px; white-space:normal; overflow-wrap:anywhere; } .notification span:first-child { font-size:12px; opacity:.7; } .actions { display:flex; gap:12px; margin-top:16px; }</style>
