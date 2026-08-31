<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'

  export let onClose: () => void

  let input: HTMLInputElement | null = null
  let query = ''
  let found: boolean | null = null
  let findTimeout: number | null = null
  let focusTimeout: number | null = null
  let highlightedQuery = ''
  let highlightedRange: Range | null = null

  const highlightName = 'balance-document-find-match'

  onMount(() => {
    void focus()
  })

  export async function focus() {
    await tick()
    input?.focus()
    input?.select()
  }

  onDestroy(() => {
    if (findTimeout !== null) window.clearTimeout(findTimeout)
    if (focusTimeout !== null) window.clearTimeout(focusTimeout)
    CSS.highlights.delete(highlightName)
  })

  function clearHighlight() {
    highlightedQuery = ''
    highlightedRange = null
    CSS.highlights.delete(highlightName)
  }

  function scrollRangeIntoView(range: Range) {
    const matchElement = range.startContainer instanceof Element
      ? range.startContainer
      : range.startContainer.parentElement
    if (!matchElement) return

    let scrollContainer = matchElement.parentElement
    let scrolledContainer = false
    while (scrollContainer) {
      const overflowY = window.getComputedStyle(scrollContainer).overflowY
      if (/(auto|scroll|overlay)/.test(overflowY) && scrollContainer.scrollHeight > scrollContainer.clientHeight) {
        const matchRect = range.getBoundingClientRect()
        const containerRect = scrollContainer.getBoundingClientRect()
        scrollContainer.scrollTop += matchRect.top
          - containerRect.top
          - (scrollContainer.clientHeight - matchRect.height) / 2
        scrolledContainer = true
      }
      scrollContainer = scrollContainer.parentElement
    }

    if (!scrolledContainer) matchElement.scrollIntoView({ block: 'center', inline: 'nearest' })
  }

  function scheduleFind(event: Event) {
    const nextQuery = event.currentTarget instanceof HTMLInputElement
      ? event.currentTarget.value
      : query
    if (nextQuery !== highlightedQuery) {
      found = null
      clearHighlight()
    }

    if (findTimeout !== null) window.clearTimeout(findTimeout)
    findTimeout = window.setTimeout(() => {
      findTimeout = null
      find()
    }, 100)
  }

  function find(backwards = false) {
    if (findTimeout !== null) {
      window.clearTimeout(findTimeout)
      findTimeout = null
    }

    if (!query) {
      found = null
      clearHighlight()
      return
    }

    const selectionStart = input?.selectionStart ?? query.length
    const selectionEnd = input?.selectionEnd ?? selectionStart

    if (
      highlightedQuery === query &&
      highlightedRange?.startContainer.isConnected &&
      highlightedRange.endContainer.isConnected
    ) {
      const selection = window.getSelection()
      selection?.removeAllRanges()
      selection?.addRange(highlightedRange)
    }

    const findInPage = (window as Window & {
      find?: (
        text: string,
        caseSensitive?: boolean,
        backwards?: boolean,
        wrapAround?: boolean,
        wholeWord?: boolean,
        searchInFrames?: boolean,
        showDialog?: boolean,
      ) => boolean
    }).find

    found = findInPage?.call(window, query, false, backwards, true, false, false, false) ?? false
    const matchSelection = window.getSelection()
    highlightedRange = found && matchSelection?.rangeCount
      ? matchSelection.getRangeAt(0).cloneRange()
      : null
    highlightedQuery = highlightedRange ? query : ''
    CSS.highlights.delete(highlightName)
    if (highlightedRange) {
      CSS.highlights.set(highlightName, new Highlight(highlightedRange))
      scrollRangeIntoView(highlightedRange)
    }

    if (focusTimeout !== null) window.clearTimeout(focusTimeout)
    focusTimeout = window.setTimeout(() => {
      focusTimeout = null
      input?.focus({ preventScroll: true })
      input?.setSelectionRange(selectionStart, selectionEnd)
    })
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    find(event.shiftKey)
  }
</script>

<div class="document-find" role="search" aria-label="Find in current document">
  <input
    bind:this={input}
    type="search"
    aria-label="Find text"
    placeholder="Find in current view"
    bind:value={query}
    on:input={scheduleFind}
    on:keydown={handleKeydown}
  />
  <span class:missing={found === false} class="find-status" role="status">
    {found === false ? 'No matches' : found === true ? 'Match' : ''}
  </span>
  <button type="button" title="Previous match (Shift+Enter)" aria-label="Previous match" on:click={() => find(true)}>↑</button>
  <button type="button" title="Next match (Enter)" aria-label="Next match" on:click={() => find()}>↓</button>
  <button type="button" title="Close (Escape)" aria-label="Close find" on:click={onClose}>×</button>
</div>

<style>
  .document-find {
    position: fixed;
    z-index: 75;
    top: max(10px, env(safe-area-inset-top));
    right: 14px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 7px;
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    background: var(--paper-strong);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  }

  input {
    width: min(230px, 42vw);
    padding-block: 6px;
  }

  .find-status {
    min-width: 40px;
    color: var(--muted);
    font-size: 11px;
    text-align: center;
    white-space: nowrap;
  }

  .find-status.missing {
    color: var(--danger);
  }

  button {
    width: 28px;
    height: 28px;
    padding: 0;
    text-align: center;
  }

  :global(::highlight(balance-document-find-match)) {
    color: inherit;
    background: color-mix(in srgb, var(--accent) 35%, transparent);
  }

  @media (max-width: 520px) {
    .document-find {
      right: 8px;
      left: 8px;
    }

    input {
      width: 100%;
      min-width: 0;
    }

    .find-status {
      display: none;
    }
  }
</style>
