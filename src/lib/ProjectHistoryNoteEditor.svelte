<script lang="ts">
  import type { Id, Note } from './types'
  import type { ItemLink } from './planner'
  import { plannerStore } from './store'
  import NoteEditorHost from './noteEditor/NoteEditorHost.svelte'
  import { balanceURLMatches, parseNavigationURL } from './navigationLinks'
  import type { NoteItem, ProjectSortRecord } from './types'
  function linkedSortIds(items: NoteItem[]): string[] {
    return items.flatMap(item => [
      ...balanceURLMatches(item.text+' '+(item.html ?? '')).flatMap(({url})=>{
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
  let inlineIds = new Set<string>()
  function attachPreviews(node: HTMLElement, records: (ProjectSortRecord | undefined)[]) {
    function refresh() {
      const ids = new Set<string>()
      for (const link of node.querySelectorAll<HTMLAnchorElement>('a[href]')) {
        const target = parseNavigationURL(link.getAttribute('href') ?? '')
        const record = target?.kind === 'project-sort' && records.find(sort => sort?.id === target.id)
        if (record && record.preview && /^data:image\/(webp|png);base64,[a-zA-Z0-9+/=]+$/.test(record.preview)) {
          link.style.setProperty('--sort-preview', `url("${record.preview}")`)
          link.classList.add('inline-sort-preview')
          ids.add(record.id)
        } else if (link.classList.contains('inline-sort-preview')) {
          link.classList.remove('inline-sort-preview')
          link.style.removeProperty('--sort-preview')
        }
      }
      inlineIds = ids
    }
    const observer = new MutationObserver(refresh)
    observer.observe(node, { childList: true, subtree: true, attributes: true, attributeFilter: ['href'] })
    refresh()
    return { update(next: typeof records) { records = next; refresh() }, destroy() { observer.disconnect() } }
  }
</script>

<div class="history-note" use:attachPreviews={previews}>
  <NoteEditorHost {note} historyRevision={$plannerStore.historyRevision} store={noteStore} listTemplates={$plannerStore.listTemplates} metrics={$plannerStore.metrics} notes={linkNotes} {onOpenLink} onAddItem={(id) => plannerStore.addProjectHistoryNoteItem(id)} />
  {#each previews as sort}
    {#if sort?.preview && !inlineIds.has(sort.id)}<button class="sort-preview" aria-label="Open saved sort" on:click={()=>onOpenLink({kind:'navigation',url:'balance://project-sort/'+sort.id,label:'Project sort'})}><img src={sort.preview} alt="Saved tabletop arrangement" /></button>{/if}
  {/each}
</div>

<style>
  .history-note :global(.inline-sort-preview)::after {
    content: ''; display: inline-block; vertical-align: middle; width: 120px; height: 72px;
    margin-inline-start: 6px; background: var(--sort-preview) center / contain no-repeat;
  }
  .sort-preview {padding:0;border:0;background:none} .sort-preview img {display:block;width:144px;max-width:100%;border-radius:4px}
  /* Formatting comes from shortcuts and the slash menu; on phones the toolbar
     still docks above the keyboard, which moves it out of this wrapper. */
  .history-note :global(.note-format-toolbar) { display: none; }
  .history-note :global(.lexical-note-editor), .history-note :global(.note-empty-editor) { min-height: 0; }
</style>
