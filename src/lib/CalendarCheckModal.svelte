<script lang="ts">
  import OverlayModal from './OverlayModal.svelte'
  import { autoGrow } from './autoGrow'
  import { readExternalPasteContent } from './externalNotePaste'
  import { countIdeas, parseIdeaImport, parseIdeaImportText } from './ideas'
  import type { PlanItem } from './types'

  // Asked before a day is planned. Pasted ideas and events join Proposition
  // Party, so the idea sort that follows picks them up.
  export let canAddToDay: boolean
  export let onImport: (items: PlanItem[]) => void
  export let onDone: (addToDay: boolean) => void
  export let onClose: () => void
  // Search, Add idea or the shortcuts list is open on top and owns the keyboard.
  export let suspended = false

  let draft = ''
  let imported = 0

  function importItems(items: PlanItem[]) {
    if (items.length === 0) return
    onImport(items)
    imported += countIdeas(items)
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
    importItems(parseIdeaImportText(draft))
    draft = ''
    onDone(addToDay)
  }

  function handleKeydown(event: KeyboardEvent) {
    if (suspended || event.metaKey || event.ctrlKey || event.altKey || event.repeat || event.isComposing) return
    const target = event.target as HTMLElement | null
    if (target?.closest('textarea')) {
      if (event.key !== 'Enter' || event.shiftKey) return
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
    {#if imported > 0}<p class="muted" role="status">{imported} to sort</p>{/if}
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
  }
  p { margin: 0; font-size: 13px; }
  .calendar-check-actions { display: flex; flex-wrap: wrap; gap: 8px; }
</style>
