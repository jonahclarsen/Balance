<script lang="ts">
  import { onMount, tick } from 'svelte'
  import OverlayModal from './OverlayModal.svelte'
  import { countIdeas, parseIdeaImport, parseIdeaImportText } from './ideaBuckets'
  import type { PlanItem } from './types'

  // Pasting a list from Apple Notes or Notesnook turns each top-level bullet
  // (or line) into an idea; nested bullets become sub-items.
  export let onImport: (items: PlanItem[]) => void
  export let onClose: () => void

  let input: HTMLTextAreaElement | null = null
  let draft = ''
  let pasted: PlanItem[] | null = null

  $: items = pasted ?? parseIdeaImportText(draft)
  $: total = countIdeas(items)

  onMount(async () => {
    await tick()
    input?.focus()
  })

  function handlePaste(event: ClipboardEvent) {
    const html = event.clipboardData?.getData('text/html') ?? ''
    const text = event.clipboardData?.getData('text/plain') ?? ''
    const parsed = parseIdeaImport(html, text)
    if (parsed.length === 0) return
    event.preventDefault()
    pasted = parsed
    draft = text || parsed.map((item) => item.text).join('\n')
  }

  function handleInput() {
    // Typing after a paste re-parses the plain text instead.
    pasted = null
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      submit()
    }
  }

  function submit() {
    if (items.length === 0) return
    onImport(items)
  }
</script>

<OverlayModal title="Import ideas" z={70} maxWidth={560} {onClose}>
  <form class="idea-import" on:submit|preventDefault={submit}>
    <textarea
      class="idea-import-input"
      rows="8"
      placeholder="Paste a list: each bullet or line becomes an idea"
      aria-label="Ideas to import"
      bind:this={input}
      bind:value={draft}
      on:paste={handlePaste}
      on:input={handleInput}
      on:keydown={handleKeydown}
    ></textarea>
    {#if items.length > 0}
      <ol class="idea-import-preview" aria-label="Import preview">
        {#each items.slice(0, 8) as item (item.id)}
          <li>{item.text}{#if item.children.length > 0}<span class="muted"> +{countIdeas(item.children)}</span>{/if}</li>
        {/each}
        {#if items.length > 8}<li class="muted">… and {items.length - 8} more</li>{/if}
      </ol>
    {/if}
    <div class="idea-import-actions">
      <button type="button" on:click={onClose}>Cancel</button>
      <button class="primary" type="submit" disabled={items.length === 0}>
        {items.length === 0 ? 'Import' : `Import ${items.length} ${items.length === 1 ? 'idea' : 'ideas'}${total > items.length ? ` (${total} with sub-items)` : ''}`}
      </button>
    </div>
  </form>
</OverlayModal>
