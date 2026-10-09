<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import { findTextRanges, normalizeFindText, scrollFindRangeIntoView } from './documentFind'

  export let onClose: () => void
  export let root: HTMLElement | null

  let bar: HTMLDivElement | null = null
  let input: HTMLInputElement | null = null
  let query = ''
  let searchedQuery = ''
  let matchRanges: Range[] = []
  let activeMatchIndex = -1
  let dirty = true
  let composing = false
  let disposed = false
  let searchTimeout: number | undefined
  let observer: MutationObserver | null = null
  let returnFocus: HTMLElement | null = null
  let returnSelection: Range | null = null
  let returnInputSelection: [number, number] | null = null

  const activeHighlightName = 'balance-document-find-match'
  const allHighlightName = 'balance-document-find-all'
  $: hasQuery = Boolean(normalizeFindText(query).text.trim())
  $: status = !hasQuery || searchedQuery !== query ? ''
    : matchRanges.length ? `${activeMatchIndex + 1}/${matchRanges.length} matches` : 'No matches'

  onMount(() => {
    void focus()
    observer = new MutationObserver(invalidate)
    if (root) observer.observe(root, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'inert', 'class', 'style', 'open'],
    })
    window.addEventListener('resize', invalidate)
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', invalidate)
    }
  })

  onDestroy(() => {
    disposed = true
    window.clearTimeout(searchTimeout)
    clearHighlights()
  })

  function rememberReturnFocus() {
    const active = document.activeElement
    if (active instanceof HTMLElement && active !== document.body && !bar?.contains(active)) {
      returnFocus = active
      const selection = window.getSelection()
      returnSelection = selection?.rangeCount && active.contains(selection.anchorNode)
        ? selection.getRangeAt(0).cloneRange() : null
      returnInputSelection = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
        && active.selectionStart !== null && active.selectionEnd !== null
        ? [active.selectionStart, active.selectionEnd] : null
    }
  }

  export async function focus() {
    rememberReturnFocus()
    await tick()
    if (disposed) return
    input?.focus({ preventScroll: true })
    input?.select()
  }

  export function close(restoreFocus = Boolean(bar?.contains(document.activeElement))) {
    // Only restore focus when leaving the bar itself. Closing after clicking
    // into a different editor must not send the caret back to the old one.
    if (restoreFocus && returnFocus?.isConnected && returnFocus.getClientRects().length) {
      returnFocus.focus({ preventScroll: true })
      if (returnInputSelection && (returnFocus instanceof HTMLInputElement || returnFocus instanceof HTMLTextAreaElement)) {
        returnFocus.setSelectionRange(...returnInputSelection)
      } else if (returnSelection && returnFocus.contains(returnSelection.commonAncestorContainer)) {
        const selection = window.getSelection()
        selection?.removeAllRanges()
        selection?.addRange(returnSelection)
      }
    }
    onClose()
  }

  function clearHighlights() {
    CSS.highlights?.delete(activeHighlightName)
    CSS.highlights?.delete(allHighlightName)
  }

  function showHighlights(refreshAll = false) {
    if (!CSS.highlights || typeof Highlight === 'undefined') return
    if (!matchRanges.length) {
      clearHighlights()
      return
    }
    if (refreshAll) {
      const all = new Highlight()
      for (const range of matchRanges) all.add(range)
      CSS.highlights.set(allHighlightName, all)
    }
    const active = new Highlight()
    const range = matchRanges[activeMatchIndex]
    if (range) active.add(range)
    active.priority = 1
    CSS.highlights.set(activeHighlightName, active)
  }

  function invalidate() {
    dirty = true
    if (searchTimeout !== undefined || composing || !hasQuery) return
    searchTimeout = window.setTimeout(() => {
      searchTimeout = undefined
      refreshMatches()
    }, 100)
  }

  function refreshMatches() {
    // Drain records synchronously so Enter immediately after an edit cannot
    // navigate stale live Ranges before the observer's microtask runs.
    if (observer?.takeRecords().length) dirty = true
    if (!dirty && searchedQuery === query) return true
    const previous = searchedQuery === query ? matchRanges[activeMatchIndex] : null
    const previousIndex = activeMatchIndex
    matchRanges = root ? findTextRanges(root, query) : []
    const retained = previous ? matchRanges.findIndex((range) =>
      range.startContainer === previous.startContainer && range.startOffset === previous.startOffset
      && range.endContainer === previous.endContainer && range.endOffset === previous.endOffset,
    ) : -1
    activeMatchIndex = !matchRanges.length ? -1 : retained >= 0 ? retained
      : searchedQuery === query ? Math.min(Math.max(previousIndex, 0), matchRanges.length - 1) : 0
    searchedQuery = query
    dirty = false
    showHighlights(true)
    return retained >= 0
  }

  function scheduleFind() {
    window.clearTimeout(searchTimeout)
    searchTimeout = undefined
    dirty = true
    clearHighlights()
    searchedQuery = ''
    matchRanges = []
    activeMatchIndex = -1
    if (composing) return
    if (!normalizeFindText(query).text.trim()) {
      searchedQuery = query
      return
    }
    searchTimeout = window.setTimeout(() => {
      searchTimeout = undefined
      refreshMatches()
      const range = matchRanges[activeMatchIndex]
      if (range) scrollFindRangeIntoView(range)
    }, 100)
  }

  export function find(backwards = false) {
    if (composing) return
    window.clearTimeout(searchTimeout)
    searchTimeout = undefined
    const advance = searchedQuery === query && matchRanges.length > 0
    const previousIndex = activeMatchIndex
    const retained = refreshMatches()
    if (matchRanges.length) {
      if (advance) {
        // If the active match vanished before the observer ran, its successor
        // now occupies the same index. Do not skip it when moving forward.
        const index = retained ? activeMatchIndex : previousIndex
        const step = backwards ? -1 : retained ? 1 : 0
        activeMatchIndex = (index + step + matchRanges.length) % matchRanges.length
      } else {
        activeMatchIndex = backwards ? matchRanges.length - 1 : 0
      }
      showHighlights()
      scrollFindRangeIntoView(matchRanges[activeMatchIndex]!)
    }
    // Synchronous focus avoids stealing it back after a subsequent click.
    input?.focus({ preventScroll: true })
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.isComposing || event.key !== 'Enter') return
    event.preventDefault()
    event.stopPropagation()
    find(event.shiftKey)
  }
</script>

<div bind:this={bar} class="document-find" role="search" aria-label="Find in current view" on:pointerdown={rememberReturnFocus}>
  <input
    bind:this={input}
    type="search"
    aria-label="Find text"
    aria-describedby="document-find-status"
    placeholder="Find in current view"
    autocomplete="off"
    spellcheck={false}
    bind:value={query}
    on:input={(event) => { query = event.currentTarget.value; scheduleFind() }}
    on:compositionstart={() => { composing = true; window.clearTimeout(searchTimeout); searchTimeout = undefined }}
    on:compositionend={() => { composing = false; scheduleFind() }}
    on:keydown={handleKeydown}
  />
  <span id="document-find-status" class:missing={status === 'No matches'} class="find-status" role="status" aria-atomic="true">{status}</span>
  <button type="button" title="Previous match (Shift+Enter)" aria-label="Previous match" disabled={!hasQuery || status === 'No matches'} on:click={() => find(true)}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>
  </button>
  <button type="button" title="Next match (Enter)" aria-label="Next match" disabled={!hasQuery || status === 'No matches'} on:click={() => find()}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 10 6 6 6-6" /></svg>
  </button>
  <button type="button" title="Close (Escape)" aria-label="Close find" on:click={() => close(true)}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
  </button>
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
    min-width: 68px;
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
    display: grid;
    place-items: center;
    flex-shrink: 0;
  }

  :global(::highlight(balance-document-find-all)) {
    background-color: color-mix(in srgb, var(--accent) 24%, transparent);
  }

  :global(::highlight(balance-document-find-match)) {
    background-color: var(--accent);
    color: var(--paper);
    text-decoration: underline;
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
  }
</style>
