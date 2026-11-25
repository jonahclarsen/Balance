<script lang="ts">
  import OverlayModal from './OverlayModal.svelte'
  import ReadOnlyNoteItem from './ReadOnlyNoteItem.svelte'
  import { navigationURL } from './navigationLinks'
  import type { Note, NoteResurfacing } from './types'

  export let note: Note
  export let record: NoteResurfacing
  // Either way it comes back at the same interval; changing that takes
  // opening the note, so pushing it back isn't one click away.
  export let onDone: () => void
  export let onOpen: () => void
  export let onClose: () => void
  // Search, Add idea or the shortcuts list is open on top and owns the keyboard.
  export let suspended = false

  // A reminder of why it comes back shows first, before the note itself.
  let viewing = !record.reason?.trim()

  function handleKeydown(event: KeyboardEvent) {
    if (suspended || event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
    const target = event.target as HTMLElement | null
    if (target?.closest('input, textarea, [contenteditable="true"]')) return
    const key = event.key.toLowerCase()
    if (!viewing && (key === 'v' || event.key === 'Enter')) viewing = true
    else if (viewing && key === 'd') onDone()
    else if (viewing && key === 'o') onOpen()
    else return
    event.preventDefault()
    event.stopPropagation()
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<OverlayModal title={note.title.trim() || 'Untitled note'} linkURL={navigationURL('note', note.id)} z={70} {onClose}>
  {#if !viewing}
    <div class="resurfaced-note">
      <p class="resurfaced-note-reason">{record.reason}</p>
      <div class="resurfaced-note-next">
        <button class="primary" type="button" on:click={() => (viewing = true)}>View note (V)</button>
      </div>
    </div>
  {:else}
    <div class="resurfaced-note">
      <div class="note-blocks">
        {#each note.items as item (item.id)}
          <ReadOnlyNoteItem {item} siblings={note.items} />
        {/each}
      </div>
      <div class="resurfaced-note-next">
        <button class="primary" type="button" on:click={onDone}>Done (D)</button>
        <button type="button" on:click={onOpen}>Open note (O)</button>
      </div>
    </div>
  {/if}
</OverlayModal>

<style>
  .resurfaced-note {
    display: grid;
    gap: 14px;
    min-width: min(420px, 70vw);
  }

  .resurfaced-note-next {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    padding-top: 12px;
    border-top: 1px solid var(--line);
  }

  .resurfaced-note-reason {
    margin: 0;
    font-size: 17px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
</style>
