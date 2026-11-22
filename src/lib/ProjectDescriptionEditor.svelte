<script lang="ts">
  // A project's description, edited with the Notes editor so it gets bullets,
  // numbered lists, checklists and indents. It is stored as marked-up lines of
  // text (see projectDescription.ts), not as note items.
  import type { ItemLink } from './planner'
  import type { Id, NoteItem, Project } from './types'
  import { plannerStore } from './store'
  import NoteEditorHost from './noteEditor/NoteEditorHost.svelte'
  import { findNoteItem } from './noteEditor/noteItems'
  import { isNoteTrashed } from './noteTrash'
  import { descriptionFromNoteItems, noteItemsFromDescription } from './projectDescription'

  export let project: Project
  export let onOpenLink: (link: ItemLink) => void = () => {}

  let items: NoteItem[] = []
  let shown: string | null = null
  // Re-read the description only when it differs from what the editor last
  // wrote, so the editor's own saves never reload it.
  $: syncFromProject(project.description, project.descriptionHtml)
  function syncFromProject(description: string, descriptionHtml: string | undefined) {
    const key = `${description}\u0000${descriptionHtml ?? ''}`
    if (key === shown) return
    shown = key
    items = noteItemsFromDescription(description, descriptionHtml, items)
  }

  function commit(next: NoteItem[]) {
    items = next
    const { description, descriptionHtml } = descriptionFromNoteItems(next)
    shown = `${description}\u0000${descriptionHtml}`
    if (description !== project.description || descriptionHtml !== (project.descriptionHtml ?? '')) {
      plannerStore.updateProject(project.id, { description, descriptionHtml })
    }
  }

  function mapItems(list: NoteItem[], change: (item: NoteItem) => NoteItem): NoteItem[] {
    return list.map((item) => {
      const children = mapItems(item.children, change)
      return change(children === item.children ? item : { ...item, children })
    })
  }

  const store = {
    patchNoteItem: (_noteId: Id, itemId: Id, patch: Partial<NoteItem>) => {
      if (!findNoteItem(items, itemId)) return
      commit(mapItems(items, (item) => item.id === itemId ? { ...item, ...patch } : item))
    },
    patchNoteItemsDone: (_noteId: Id, itemIds: Id[], done: boolean) => {
      const ids = new Set(itemIds)
      commit(mapItems(items, (item) => ids.has(item.id) ? { ...item, done } : item))
    },
    replaceNoteItems: (_noteId: Id, next: NoteItem[]) => commit(next),
  }

  $: note = { id: project.id, items }
</script>

<div class="project-description-editor">
  <NoteEditorHost {note} historyRevision={$plannerStore.historyRevision} {store} ariaLabel="Description" listTemplates={$plannerStore.listTemplates} metrics={$plannerStore.metrics} notes={$plannerStore.notes.filter((note) => !isNoteTrashed(note))} {onOpenLink} onAddItem={() => {
    const item = noteItemsFromDescription('', undefined)[0]
    commit([item])
    return item.id
  }} />
</div>

<style>
  /* Formatting comes from shortcuts and the slash menu, as in project history. */
  .project-description-editor :global(.note-format-toolbar), .project-description-editor :global(.note-collapse) { display: none; }
  /* The field's pre-wrap would show the markup's whitespace as a blank line. */
  .project-description-editor { white-space: normal; }
  .project-description-editor :global(.note-empty-editor) { min-height: 0; }
  /* Sized like the field's plain text rather than a Notes page. */
  .project-description-editor :global(.lexical-note-editor) {
    --note-body-size: 13px;
    --note-body-line: 1.5;
    --note-marker-column: 14px;
    --note-check-size: 14px;
    --note-child-indent: 18px;
    min-height: 0;
    padding: 0;
    font-family: inherit;
  }
  .project-description-editor :global(.note-block) { min-height: 0; padding: 0; }
  .project-description-editor :global(.note-text) { min-height: 1.5em; padding: 0; font-family: inherit; font-size: var(--note-body-size); line-height: var(--note-body-line); }
  .project-description-editor :global(.note-children > .note-item) { margin-left: 0; }
  .project-description-editor :global(.note-list-item > .note-block) { padding-left: calc(var(--note-marker-column) + 4px); }
  .project-description-editor :global(.note-bullet > .note-block::before),
  .project-description-editor :global(.note-numbered > .note-block::before) { top: 0; left: 0; width: var(--note-marker-column); font-size: 13px; padding-top: 0; transform: none; }
  .project-description-editor :global(.note-numbered > .note-block::before) { padding-right: 2px; font-size: 12px; }
  .project-description-editor :global(.note-check) {
    top: calc((var(--note-body-size) * var(--note-body-line) - var(--note-check-size)) / 2);
    left: 0;
  }
  .project-description-editor :global(.note-children::before) { left: -11px; }
  .project-description-editor :global(.note-checklist > .note-children::before) { left: calc(var(--note-check-size) / 2 - var(--note-child-indent)); }
  .project-description-editor :global(.note-item.note-heading) { padding-top: 6px; font-size: 15px; }
  .project-description-editor :global(.note-item.note-heading:first-child) { padding-top: 0; }
  .project-description-editor :global(.note-heading > .note-block) { min-height: 0; padding: 0; }
  .project-description-editor :global(.note-heading > .note-block > .note-text) { min-height: 0; font-size: 15px; }
</style>
