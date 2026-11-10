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

  // A reminder of why it comes back shows first, before the note itself.
  let viewing = !record.reason?.trim()
</script>

<OverlayModal title={note.title.trim() || 'Untitled note'} linkURL={navigationURL('note', note.id)} z={70} {onClose}>
  {#if !viewing}
    <div class="resurfaced-note">
      <p class="resurfaced-note-reason">{record.reason}</p>
      <div class="resurfaced-note-next">
        <button class="primary" type="button" on:click={() => (viewing = true)}>View note</button>
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
        <button class="primary" type="button" on:click={onDone}>Done</button>
        <button type="button" on:click={onOpen}>Open note</button>
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
