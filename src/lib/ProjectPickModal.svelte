<script lang="ts">
  import type { Id, Project } from './types'
  import OverlayModal from './OverlayModal.svelte'
  import { endedProjectsOn, isProjectOpen, PROJECT_ACTIVE_DAY_COUNTS } from './projects'

  // Asked while generating a day that would start with no active project:
  // settle the projects whose stretch ended, then pick the next ones.
  export let projects: Project[]
  export let date: string
  export let onAdd: (name: string) => Id | null
  export let onDone: (endings: Record<Id, 'completed' | 'archived' | 'open'>, activeIds: Id[], days: number) => void
  export let onClose: () => void

  let endings: Record<Id, 'completed' | 'archived'> = {}
  let selected = new Set<Id>()
  let name = ''

  // Ended projects lead and keep their place while being settled.
  const endedIds = new Set(endedProjectsOn(projects, date).map(({ id }) => id))
  $: open = projects.filter(isProjectOpen)
  $: rows = [...open.filter(({ id }) => endedIds.has(id)), ...open.filter(({ id }) => !endedIds.has(id))]
  $: pickable = rows.filter(({ id }) => !endings[id])

  function toggle(id: Id) {
    selected = new Set(selected.has(id) ? [...selected].filter((other) => other !== id) : [...selected, id])
  }
  function settle(id: Id, ending: 'completed' | 'archived') {
    const { [id]: previous, ...rest } = endings
    endings = previous === ending ? rest : { ...rest, [id]: ending }
    if (selected.has(id)) toggle(id)
  }
  function add() {
    const id = onAdd(name)
    if (!id) return
    name = ''
    selected = new Set([...selected, id])
  }
  function finish(days: number) {
    const all = Object.fromEntries([...endedIds].map((id) => [id, endings[id] ?? 'open'] as const))
    onDone(all, [...selected].filter((id) => !endings[id]), days)
  }
</script>

<OverlayModal title="Pick projects" z={68} maxWidth={480} {onClose}>
  <div class="project-pick">
    <ul>
      {#each rows as project (project.id)}
        <li class:settled={endings[project.id]}>
          <button
            class="pick"
            type="button"
            aria-pressed={selected.has(project.id)}
            disabled={Boolean(endings[project.id])}
            on:click={() => toggle(project.id)}
          >{project.name}{#if endedIds.has(project.id)}<small>ended</small>{/if}</button>
          {#if endedIds.has(project.id)}
            <button type="button" aria-pressed={endings[project.id] === 'completed'} on:click={() => settle(project.id, 'completed')}>Complete</button>
            <button type="button" aria-pressed={endings[project.id] === 'archived'} on:click={() => settle(project.id, 'archived')}>Archive</button>
          {/if}
        </li>
      {/each}
    </ul>
    <form on:submit|preventDefault={add}>
      <input bind:value={name} placeholder="New project" aria-label="New project name" />
      <button type="submit" disabled={!name.trim()}>Add</button>
    </form>
    {#if pickable.length > 0}
      <div class="days" role="group" aria-label="Days active">
        <span>Days</span>
        {#each PROJECT_ACTIVE_DAY_COUNTS as days}
          <button
            class="primary"
            type="button"
            disabled={selected.size === 0}
            aria-label={`${days} ${days === 1 ? 'day' : 'days'}`}
            on:click={() => finish(days)}
          >{days}</button>
        {/each}
      </div>
    {:else}
      <button class="primary" type="button" on:click={() => finish(1)}>Continue</button>
    {/if}
  </div>
</OverlayModal>

<style>
  .project-pick { display: grid; gap: 14px; }
  ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  li { display: flex; align-items: center; gap: 6px; min-width: 0; }
  li button { font-size: 13px; padding: 7px 10px; }
  li button[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); color: var(--paper); }
  .pick { flex: 1; min-width: 0; display: flex; align-items: baseline; gap: 8px; text-align: left; font-size: 14px; overflow-wrap: anywhere; }
  .pick small { margin-left: auto; color: var(--muted); font-size: 12px; }
  .pick[aria-pressed='true'] small { color: inherit; }
  .settled .pick { text-decoration: line-through; opacity: .55; }
  form { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 6px; }
  form input { min-width: 0; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper-strong); color: var(--ink); font: inherit; font-size: 14px; }
  form button { font-size: 13px; padding: 7px 12px; }
  .days { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .days span { color: var(--muted); font-size: 13px; margin-right: 4px; }
  .days button { min-width: 40px; padding: 8px 0; font-size: 15px; font-variant-numeric: tabular-nums; }
  .days button:disabled { opacity: .45; cursor: default; }
</style>
