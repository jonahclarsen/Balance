<script lang="ts">
  import { CATEGORIES, type Category, type Target } from './situate/core'
  import { KINDS, categoryOf, guessKind } from './situate/ui'
  import SituateIcon from './SituateIcon.svelte'
  export let targets: Target[]
  let query = ''
  let filter: Category | '' = ''
  let menu: { id: string; field: 'kind' | 'category' } | null = null
  let draft = ''
  let draftKind: Target['kind'] | null = null
  let draftCategory: Category = 'social'
  let error = ''
  $: shown = targets.filter(t => (!filter || t.category === filter) && t.value.toLowerCase().includes(query.trim().toLowerCase()))
  $: addKind = draftKind ?? guessKind(draft.trim())
  const id = (kind: Target['kind'], value: string) => `${kind}:${value}`
  function change(target: Target, patch: Partial<Target>) {
    const next = { ...target, ...patch }
    next.value = next.value.trim()
    next.id = id(next.kind, next.value)
    if (!next.value) { error = 'Enter an app ID or website'; return }
    if (next.id !== target.id && targets.some(t => t.id === next.id)) { error = `${next.value} is already blocked`; return }
    error = ''
    targets = targets.map(t => t.id === target.id ? next : t)
  }
  function add() {
    const value = draft.trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '')
    if (!value) return
    const target: Target = { id: id(addKind, addKind === 'domain' ? value.toLowerCase() : value), kind: addKind, category: draftCategory, value: addKind === 'domain' ? value.toLowerCase() : value }
    if (targets.some(t => t.id === target.id)) { error = `${value} is already blocked`; return }
    error = ''
    targets = [target, ...targets]
    draft = ''; draftKind = null
  }
  function closeMenu(event: MouseEvent) {
    if (menu && !(event.target as Element).closest?.('.chip-cell')) menu = null
  }
</script>
<svelte:window on:click={closeMenu} />
<div class="targets-panel">
  <div class="toolbar">
    <input class="search" type="search" placeholder="Search" aria-label="Search blocked apps and websites" bind:value={query} />
    <div class="filters" role="group" aria-label="Filter by category">
      <button type="button" class="filter" aria-pressed={!filter} on:click={() => filter = ''}>All <span>{targets.length}</span></button>
      {#each CATEGORIES as category}
        {@const count = targets.filter(t => t.category === category.id).length}
        {#if count}<button type="button" class="filter" style:--c={category.color} aria-pressed={filter === category.id} on:click={() => filter = filter === category.id ? '' : category.id}><i></i>{category.label} <span>{count}</span></button>{/if}
      {/each}
    </div>
  </div>
  <form class="add" on:submit|preventDefault={add}>
    <input placeholder="Add app ID or website" aria-label="App ID or website to block" bind:value={draft} />
    <div class="choice" role="group" aria-label="Type">{#each KINDS as kind}<button type="button" aria-pressed={addKind === kind.id} title={kind.label} on:click={() => draftKind = kind.id}><SituateIcon name={kind.id} size={14} /><span>{kind.label}</span></button>{/each}</div>
    <div class="choice" role="group" aria-label="Category">{#each CATEGORIES as category}<button type="button" style:--c={category.color} aria-pressed={draftCategory === category.id} on:click={() => draftCategory = category.id}><i></i><span>{category.label}</span></button>{/each}</div>
    <button class="primary" type="submit" disabled={!draft.trim()}>Add</button>
  </form>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  <div class="table" role="table" aria-label="Blocked apps and websites">
    <div class="row head" role="row"><span role="columnheader">App or website</span><span role="columnheader">Type</span><span role="columnheader">Category</span><span role="columnheader"><span class="sr-only">Remove</span></span></div>
    <div class="rows">
      {#each shown as target (target.id)}
        {@const category = categoryOf(target.category)}
        {@const kind = KINDS.find(k => k.id === target.kind)}
        <div class="row" role="row" style:--c={category.color}>
          <span role="cell"><input class="value" value={target.value} aria-label={`Edit ${target.value}`} spellcheck="false" on:change={e => change(target, { value: e.currentTarget.value })} on:keydown={e => { if (e.key === 'Enter') e.currentTarget.blur() }} /></span>
          <span role="cell" class="chip-cell">
            <button type="button" class="chip kind" aria-haspopup="true" aria-expanded={menu?.id === target.id && menu.field === 'kind'} on:click={() => menu = menu?.id === target.id && menu.field === 'kind' ? null : { id: target.id, field: 'kind' }}><SituateIcon name={target.kind} size={13} />{kind?.label}</button>
            {#if menu?.id === target.id && menu.field === 'kind'}<div class="menu">{#each KINDS as option}<button type="button" aria-pressed={option.id === target.kind} on:click={() => { menu = null; change(target, { kind: option.id }) }}><SituateIcon name={option.id} size={13} />{option.label}</button>{/each}</div>{/if}
          </span>
          <span role="cell" class="chip-cell">
            <button type="button" class="chip category" aria-haspopup="true" aria-expanded={menu?.id === target.id && menu.field === 'category'} on:click={() => menu = menu?.id === target.id && menu.field === 'category' ? null : { id: target.id, field: 'category' }}><i></i>{category.label}</button>
            {#if menu?.id === target.id && menu.field === 'category'}<div class="menu">{#each CATEGORIES as option}<button type="button" style:--c={option.color} aria-pressed={option.id === target.category} on:click={() => { menu = null; change(target, { category: option.id }) }}><i></i>{option.label}</button>{/each}</div>{/if}
          </span>
          <span role="cell"><button type="button" class="icon-button quiet remove" title="Remove" aria-label={`Remove ${target.value}`} on:click={() => targets = targets.filter(t => t.id !== target.id)}>✕</button></span>
        </div>
      {:else}
        <p class="empty">{targets.length ? 'No matches' : 'Nothing blocked yet'}</p>
      {/each}
    </div>
  </div>
</div>
<style>
  .targets-panel { border:1px solid var(--line-strong); border-radius:12px; background:var(--paper-strong); overflow:hidden; }
  .toolbar { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px; border-bottom:1px solid var(--line); }
  .search, .add input { font-size:14px; padding:6px 10px; }
  .search { flex:1 1 140px; min-width:0; }
  .filters, .choice { display:flex; flex-wrap:wrap; gap:4px; }
  .filter, .choice button { display:inline-flex; align-items:center; gap:5px; min-height:28px; padding:3px 9px; border-radius:999px; font-size:12px; border:1px solid var(--line); background:transparent; color:var(--muted); }
  .filter span { opacity:.7; font-variant-numeric:tabular-nums; }
  .filter[aria-pressed='true'], .choice button[aria-pressed='true'] { color:var(--ink); background:color-mix(in srgb, var(--c, var(--accent)) 14%, transparent); border-color:color-mix(in srgb, var(--c, var(--accent)) 55%, transparent); }
  i { display:inline-block; width:8px; height:8px; border-radius:50%; background:var(--c); flex:none; }
  .add { display:flex; flex-wrap:wrap; gap:8px; align-items:center; padding:10px; background:color-mix(in srgb, var(--accent) 5%, transparent); border-bottom:1px solid var(--line); }
  .add input { flex:1 1 180px; min-width:0; }
  .add .primary { padding:6px 16px; font-size:14px; }
  .error { margin:0; padding:6px 12px; color:var(--danger); font-size:13px; border-bottom:1px solid var(--line); }
  .row { display:grid; grid-template-columns:minmax(0,1fr) 108px 132px 32px; align-items:center; gap:8px; padding:0 8px 0 4px; min-height:34px; border-bottom:1px solid var(--row-border); }
  .rows { max-height:min(46vh, 420px); overflow:auto; }
  .rows .row:last-child { border-bottom:none; }
  .rows .row:hover { background:color-mix(in srgb, var(--c) 6%, transparent); }
  .head { min-height:30px; font-size:11px; font-weight:650; letter-spacing:.04em; text-transform:uppercase; color:var(--muted); background:var(--paper); border-bottom:1px solid var(--line); padding-left:12px; }
  .value { width:100%; border:1px solid transparent; background:transparent; padding:4px 8px; font-size:13px; font-family:var(--font-mono); border-radius:6px; }
  .value:hover { border-color:var(--line); }
  .value:focus { border-color:var(--accent); background:var(--paper); }
  .chip-cell { position:relative; }
  .chip { display:inline-flex; align-items:center; gap:5px; padding:2px 9px; min-height:24px; border-radius:999px; font-size:12px; border:1px solid var(--line); background:transparent; color:var(--muted); }
  .chip.category { color:color-mix(in srgb, var(--c) 72%, var(--ink)); background:color-mix(in srgb, var(--c) 13%, transparent); border-color:color-mix(in srgb, var(--c) 40%, transparent); font-weight:600; }
  .menu { position:absolute; z-index:5; top:calc(100% + 2px); left:0; display:grid; gap:2px; min-width:140px; padding:4px; border:1px solid var(--line-strong); border-radius:10px; background:var(--paper-strong); box-shadow:var(--shadow); }
  .menu button { display:flex; align-items:center; gap:7px; justify-content:flex-start; border:none; background:transparent; padding:6px 8px; border-radius:6px; font-size:13px; }
  .menu button:hover, .menu button[aria-pressed='true'] { background:var(--active-nav); }
  .remove { width:28px; height:28px; opacity:.55; }
  .row:hover .remove, .remove:focus-visible { opacity:1; }
  .empty { margin:0; padding:18px; text-align:center; color:var(--muted); font-size:13px; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
  @media (max-width:600px) { .row { grid-template-columns:minmax(0,1fr) 34px 104px 30px; } .chip.kind { font-size:0; gap:0; padding:4px 6px; } .choice span { display:none; } .choice button[style] span { display:inline; } }
</style>
