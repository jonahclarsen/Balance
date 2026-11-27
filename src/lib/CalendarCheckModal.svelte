<script lang="ts">
  import OverlayModal from './OverlayModal.svelte'
  import { autoGrow } from './autoGrow'
  import { readExternalPasteContent } from './externalNotePaste'
  import { parseIdeaImport, parseIdeaImportText } from './ideas'
  import type { PlanItem } from './types'

  // Asked before a day is planned. Pasted ideas and events join Proposition
  // Party and are sorted straight away; typed ones are sorted after Done.
  export let canAddToDay: boolean
  export let draft = ''
  // Sorts ideas now, then shows the check again.
  export let onImport: (items: PlanItem[]) => void
  // Typed ideas still in the box go to Proposition Party, sorted next.
  export let onDone: (addToDay: boolean, typed: PlanItem[]) => void
  export let onClose: () => void
  // Search, Add idea or the shortcuts list is open on top and owns the keyboard.
  export let suspended = false

  function importItems(items: PlanItem[]) {
    if (items.length > 0) onImport(items)
  }

  function handlePaste(event: ClipboardEvent) {
    if (suspended) return
    const target = event.target as HTMLElement | null
    if (target?.closest('[contenteditable="true"], input')) return
    const data = event.clipboardData
    if (!data) return
    event.preventDefault()
    void readExternalPasteContent(data).then(({ html, text }) => {
      const parsed = parseIdeaImport(html, text)
      importItems(parsed.length > 0 ? parsed : parseIdeaImportText(text))
    })
  }

  function finish(addToDay: boolean) {
    const typed = parseIdeaImportText(draft)
    draft = ''
    onDone(addToDay, typed)
  }

  function sortTyped() {
    const typed = parseIdeaImportText(draft)
    draft = ''
    importItems(typed)
  }

  function handleKeydown(event: KeyboardEvent) {
    if (suspended || event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.isComposing) return
    const target = event.target as HTMLElement | null
    if (target?.closest('textarea')) {
      if (event.key !== 'Enter' || event.shiftKey) return
      // Enter sorts what was typed; once the box is empty it means Done.
      if (draft.trim()) {
        event.preventDefault()
        event.stopPropagation()
        sortTyped()
        return
      }
    } else if (target?.closest('input, [contenteditable="true"]')) return
    const key = event.key.toLowerCase()
    if (event.key === 'Enter') finish(false)
    else if (key === 'd' && canAddToDay) finish(true)
    else return
    event.preventDefault()
    event.stopPropagation()
  }
</script>

<svelte:window on:keydown={handleKeydown} on:paste={handlePaste} />

<OverlayModal title="Emptied your whole calendar?" z={70} maxWidth={480} {onClose}>
  <div class="calendar-check">
    <textarea
      rows="2"
      placeholder="Paste ideas or events to sort"
      aria-label="Ideas to sort"
      bind:value={draft}
      use:autoGrow={draft}
    ></textarea>
    <div class="calendar-check-actions">
      <button class="primary" type="button" on:click={() => finish(false)}>Done (Enter)</button>
      <button
        type="button"
        disabled={!canAddToDay}
        title={canAddToDay ? undefined : 'Added yesterday'}
        on:click={() => finish(true)}
      >Add to day (D)</button>
    </div>
  </div>
</OverlayModal>

<style>
  .calendar-check { display: grid; gap: 12px; }
  textarea {
    min-width: 0;
    padding: 8px 10px;
    border: 1px solid var(--line);
    border-radius: 6px;
    background: var(--paper-strong);
    color: var(--ink);
    font: inherit;
    font-size: 14px;
    resize: none;
    /* autoGrow fits the box to its text, so it never needs a scrollbar. */
    overflow: hidden;
  }
  .calendar-check-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
