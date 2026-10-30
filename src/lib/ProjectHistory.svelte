<script lang="ts">
  import type { Id, Note, NoteItem, Project, ProjectHistoryNote } from './types'
  import type { ItemLink } from './planner'
  import { plannerStore } from './store'
  import OverlayModal from './OverlayModal.svelte'
  import NoteEditorHost from './noteEditor/NoteEditorHost.svelte'
  import { mountInContentShell } from './contentShellOverlay'
  import { isNoteTrashed } from './noteTrash'
  import {
    historyDayHeading, isProjectOpen, periodDays, periodFromDays, PROJECT_BACKSTORY_NOTE_ID, projectHistoryNoteDay,
    projectHistoryNoteId, projectHistoryPeriods, type ProjectHistoryEntry,
  } from './projects'
  export let projects: Project[] = []
  export let onOpenLink: (link: ItemLink) => void = () => {}

  type Draft = { periodId: Id | null; projectId: Id; first: string; last: string; original?: { first: string; last: string; start: string; end: string } }
  let draft: Draft | null = null

  // Keep references stable so unrelated edits don't refresh every editor.
  let historyNotes = $plannerStore.projectHistoryNotes
  let allNotes = $plannerStore.notes
  let linkNotes = allNotes.filter((note) => !isNoteTrashed(note))
  $: if (historyNotes !== $plannerStore.projectHistoryNotes) historyNotes = $plannerStore.projectHistoryNotes
  $: if (allNotes !== $plannerStore.notes) {
    allNotes = $plannerStore.notes
    linkNotes = allNotes.filter((note) => !isNoteTrashed(note))
  }
  $: notesById = new Map(historyNotes.map((note) => [note.id, note]))
  $: notedDays = historyNotes.flatMap((note) => {
    const day = projectHistoryNoteDay(note.id)
    return day && hasContent(note.items) ? [day] : []
  })
  $: periods = projectHistoryPeriods(projects, notedDays)
  const noteStore = {
    patchNoteItem: plannerStore.patchProjectHistoryNoteItem,
    patchNoteItemsDone: plannerStore.patchProjectHistoryNoteItemsDone,
    replaceNoteItems: plannerStore.replaceProjectHistoryNoteItems,
  }
  // Writing that doesn't exist yet opens as an empty note.
  const blankNotes = new Map<Id, Pick<Note, 'id' | 'items'>>()
  function noteFor(byId: Map<Id, ProjectHistoryNote>, id: Id): Pick<Note, 'id' | 'items'> {
    const note = byId.get(id)
    if (note) return note
    if (!blankNotes.has(id)) blankNotes.set(id, { id, items: [] })
    return blankNotes.get(id)!
  }
  function hasContent(items: NoteItem[]): boolean {
    return items.some((item) => item.text.trim() || item.kind !== 'paragraph' || item.children.length)
  }
  // Open projects lead the picker, in their own order.
  $: pickable = [...projects.filter(isProjectOpen), ...projects.filter((project) => !isProjectOpen(project))]
  $: draftValid = Boolean(draft?.projectId && draft.first && draft.last && draft.first <= draft.last)

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
  {#each periods as period (period.day)}
    <section class="history-period" aria-label={historyDayHeading(period.day)}>
      <h3 class="note-static-heading">{historyDayHeading(period.day)}</h3>
      {#if period.entries.length}
        <ul>
          {#each period.entries as entry (entry.period.id)}
            {@const days = periodDays(entry.period)}
            <li>
              <button type="button" style:--project-color={entry.project.color} on:click={() => editEntry(entry)}>
                <span class="project-dot" aria-hidden="true"></span>
                <span class="history-name">{entry.project.name}</span>
                <span class="history-days">{dayCount(days.first, days.last)}d</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
      <div class="history-note">
        <NoteEditorHost note={noteFor(notesById, projectHistoryNoteId(period.day))} historyRevision={$plannerStore.historyRevision} store={noteStore} listTemplates={$plannerStore.listTemplates} metrics={$plannerStore.metrics} notes={linkNotes} {onOpenLink} onAddItem={(noteId) => plannerStore.addProjectHistoryNoteItem(noteId)} />
      </div>
    </section>
  {/each}
  <section class="history-period" aria-label="backstory">
    <h3 class="note-static-heading">backstory</h3>
    <div class="history-note">
      <NoteEditorHost note={noteFor(notesById, PROJECT_BACKSTORY_NOTE_ID)} historyRevision={$plannerStore.historyRevision} store={noteStore} listTemplates={$plannerStore.listTemplates} metrics={$plannerStore.metrics} notes={linkNotes} {onOpenLink} onAddItem={(noteId) => plannerStore.addProjectHistoryNoteItem(noteId)} />
    </div>
  </section>
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
  .project-history { display: grid; gap: 28px; }
  .history-overlay { display: contents; }
  .history-add { justify-self: start; font-size: 14px; padding: 8px 12px; }
  .history-period { display: grid; gap: 10px; min-width: 0; }
  ul { margin: 0; padding: 0; list-style: none; display: grid; gap: 6px; }
  li button { display: grid; grid-template-columns: auto minmax(0, 1fr) 3ch; align-items: center; gap: 10px; width: 100%; text-align: left; font-size: 14px; padding: 9px 12px; }
  .history-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .history-days { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  /* Formatting comes from shortcuts and the slash menu; on phones the toolbar
     still docks above the keyboard, which moves it out of this wrapper. */
  .history-note :global(.note-format-toolbar) { display: none; }
  .history-note :global(.lexical-note-editor), .history-note :global(.note-empty-editor) { min-height: 0; }
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
