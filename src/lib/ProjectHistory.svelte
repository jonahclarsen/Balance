<script lang="ts">
  import type { Id, Project } from './types'
  import { plannerStore } from './store'
  import OverlayModal from './OverlayModal.svelte'
  import { mountInContentShell } from './contentShellOverlay'
  import { isProjectOpen, periodDays, periodFromDays, projectHistory, type ProjectHistoryEntry } from './projects'
  export let projects: Project[] = []

  type Draft = { periodId: Id | null; projectId: Id; first: string; last: string; original?: { first: string; last: string; start: string; end: string } }
  let draft: Draft | null = null

  $: entries = projectHistory(projects)
  // Open projects lead the picker, in their own order.
  $: pickable = [...projects.filter(isProjectOpen), ...projects.filter((project) => !isProjectOpen(project))]
  $: draftValid = Boolean(draft?.projectId && draft.first && draft.last && draft.first <= draft.last)

  function dayLabel(date: string) {
    const day = new Date(`${date}T12:00:00`)
    return day.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(day.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })
  }
  function dayCount(first: string, last: string) {
    return Math.round((Date.parse(`${last}T12:00:00Z`) - Date.parse(`${first}T12:00:00Z`)) / 86_400_000) + 1
  }
  function today() {
    const now = new Date()
    return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
  }
  function addEntry() {
    draft = { periodId: null, projectId: pickable[0]?.id ?? '', first: today(), last: today() }
  }
  function editEntry({ project, period }: ProjectHistoryEntry) {
    const { first, last } = periodDays(period)
    draft = { periodId: period.id, projectId: project.id, first, last, original: { first, last, start: period.start, end: period.end } }
  }
  function save() {
    if (!draft || !draftValid) return
    // Unchanged days keep their exact times, such as an evening start.
    const { original } = draft
    const span = periodFromDays(draft.first, draft.last)
    const start = original && original.first === draft.first ? original.start : span.start
    const end = original && original.last === draft.last ? original.end : span.end
    plannerStore.saveProjectActivePeriod(draft.periodId, draft.projectId, start, end)
    draft = null
  }
  function remove() {
    if (draft?.periodId) plannerStore.deleteProjectActivePeriod(draft.periodId)
    draft = null
  }
</script>

<div class="project-history">
  <button class="primary history-add" type="button" disabled={!projects.length} on:click={addEntry}>Add</button>
  {#if entries.length}
    <ul>
      {#each entries as entry (entry.period.id)}
        {@const days = periodDays(entry.period)}
        <li>
          <button type="button" style:--project-color={entry.project.color} on:click={() => editEntry(entry)}>
            <span class="project-dot" aria-hidden="true"></span>
            <span class="history-name">{entry.project.name}</span>
            <span class="history-dates">{dayLabel(days.first)}{days.last !== days.first ? ` – ${dayLabel(days.last)}` : ''}</span>
            <span class="history-days">{dayCount(days.first, days.last)}d</span>
          </button>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="muted">None yet.</p>
  {/if}
</div>

{#if draft}
  <div class="history-overlay" use:mountInContentShell>
  <OverlayModal title={draft.periodId ? 'Edit' : 'Add'} ariaLabel={draft.periodId ? 'Edit active stretch' : 'Add active stretch'} z={65} maxWidth={420} onClose={() => draft = null}>
    <form class="history-editor" on:submit|preventDefault={save}>
      <div class="history-projects" role="group" aria-label="Project">
        {#each pickable as project (project.id)}
          <button type="button" style:--project-color={project.color} aria-pressed={draft.projectId === project.id} on:click={() => draft && (draft.projectId = project.id)}>
            <span class="project-dot" aria-hidden="true"></span>{project.name}
          </button>
        {/each}
      </div>
      <div class="history-range">
        <label><span>From</span><input type="date" bind:value={draft.first} required /></label>
        <label><span>To</span><input type="date" bind:value={draft.last} min={draft.first} required /></label>
      </div>
      <div class="history-actions">
        <button class="primary" type="submit" disabled={!draftValid}>Save</button>
        {#if draft.periodId}<button class="ghost danger" type="button" on:click={remove}>Delete</button>{/if}
      </div>
    </form>
  </OverlayModal>
  </div>
{/if}

<style>
  .project-history { display: grid; gap: 12px; }
  .history-overlay { display: contents; }
  .history-add { justify-self: start; font-size: 14px; padding: 8px 12px; }
  ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  li button { display: grid; grid-template-columns: auto minmax(0, 1fr) auto 3ch; align-items: center; gap: 10px; width: 100%; text-align: left; font-size: 14px; padding: 9px 12px; }
  .history-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .history-dates, .history-days { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .history-days { text-align: right; }
  .project-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--project-color); }
  .history-editor { display: grid; gap: 14px; }
  .history-projects { display: flex; flex-wrap: wrap; gap: 6px; max-height: 40vh; overflow-y: auto; }
  .history-projects button { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; padding: 6px 10px; }
  .history-projects button[aria-pressed='true'] { background: var(--accent); border-color: var(--accent); color: var(--paper); }
  .history-range { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
  .history-range label { display: grid; gap: 6px; font-size: 13px; }
  .history-range input { min-width: 0; padding: 7px 10px; border: 1px solid var(--line); border-radius: 6px; background: var(--paper-strong); color: var(--ink); font: inherit; font-size: 14px; }
  .history-actions { display: flex; gap: 8px; }
  .history-actions button { font-size: 14px; padding: 8px 12px; }
</style>
