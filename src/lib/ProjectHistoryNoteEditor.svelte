<script lang="ts">
  import type { Id, Note } from './types'
  import type { ItemLink } from './planner'
  import { plannerStore } from './store'
  import NoteEditorHost from './noteEditor/NoteEditorHost.svelte'
  import { balanceURLMatches, parseNavigationURL } from './navigationLinks'
  import type { NoteItem } from './types'
  function linkedSortIds(items: NoteItem[]): string[] {
    return items.flatMap(item => [
      ...balanceURLMatches(item.text).flatMap(({url})=>{
        const target=parseNavigationURL(url)
        return target?.kind==='project-sort' ? [target.id] : []
      }),
      ...linkedSortIds(item.children),
    ])
  }
  import { isNoteTrashed } from './noteTrash'

  export let noteId: Id
  export let onOpenLink: (link: ItemLink) => void = () => {}

  // Keep references stable so unrelated edits don't refresh the editor.
  let historyNotes = $plannerStore.projectHistoryNotes
  let allNotes = $plannerStore.notes
  let linkNotes = allNotes.filter((note) => !isNoteTrashed(note))
  $: if (historyNotes !== $plannerStore.projectHistoryNotes) historyNotes = $plannerStore.projectHistoryNotes
  $: if (allNotes !== $plannerStore.notes) {
    allNotes = $plannerStore.notes
    linkNotes = allNotes.filter((note) => !isNoteTrashed(note))
  }

  const noteStore = {
    patchNoteItem: plannerStore.patchProjectHistoryNoteItem,
    patchNoteItemsDone: plannerStore.patchProjectHistoryNoteItemsDone,
    replaceNoteItems: plannerStore.replaceProjectHistoryNoteItems,
  }
  // Writing that doesn't exist yet opens as an empty note.
  let blank: Pick<Note, 'id' | 'items'> = { id: noteId, items: [] }
  $: if (blank.id !== noteId) blank = { id: noteId, items: [] }
  $: note = historyNotes.find(({ id }) => id === noteId) ?? blank
  $: previews = [...new Set(linkedSortIds(note.items))].map(id=>$plannerStore.projectSorts.find(s=>s.id===id && s.saved))
</script>

<div class="history-note">
  <NoteEditorHost {note} historyRevision={$plannerStore.historyRevision} store={noteStore} listTemplates={$plannerStore.listTemplates} metrics={$plannerStore.metrics} notes={linkNotes} {onOpenLink} onAddItem={(id) => plannerStore.addProjectHistoryNoteItem(id)} />
  {#each previews as sort}
    {#if sort?.preview}<button class="sort-preview" aria-label="Open saved sort" on:click={()=>onOpenLink({kind:'navigation',url:'balance://project-sort/'+sort.id,label:'Project sort'})}><img src={sort.preview} alt="Saved tabletop arrangement" /></button>{/if}
  {/each}
</div>

<style>
  .sort-preview {padding:0;border:0;background:none} .sort-preview img {display:block;width:144px;max-width:100%;border-radius:4px}
  /* Formatting comes from shortcuts and the slash menu; on phones the toolbar
     still docks above the keyboard, which moves it out of this wrapper. */
  .history-note :global(.note-format-toolbar) { display: none; }
  .history-note :global(.lexical-note-editor), .history-note :global(.note-empty-editor) { min-height: 0; }
</style>
