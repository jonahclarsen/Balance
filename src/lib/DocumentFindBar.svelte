<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import { findTextRanges, firstVisibleFindIndex, maxFindMatches, normalizeFindText, scrollFindRangeIntoView } from './documentFind'
  import { createFindHighlights } from './findHighlights'
  import { rememberFocusReturn, type FocusReturn } from './focusReturn'

  export let onClose: () => void
  export let root: HTMLElement | null
  // Owned by the parent so reopening find shows the last query, like browsers.
  export let query = ''

  let bar: HTMLDivElement | null = null
  let input: HTMLInputElement | null = null
  let searchedQuery = ''
  let matchRanges: Range[] = []
  let activeMatchIndex = -1
  let dirty = true
  let composing = false
  let disposed = false
  let searchTimeout: number | undefined
  let observer: MutationObserver | null = null
  let returnFocus: FocusReturn | null = null
  const highlights = createFindHighlights()

  $: hasQuery = Boolean(normalizeFindText(query).text.trim())
  $: searched = hasQuery && searchedQuery === query
  $: missing = searched && !matchRanges.length
  $: total = matchRanges.length >= maxFindMatches ? `${maxFindMatches}+` : matchRanges.length
  $: status = !searched ? '' : missing ? '0/0' : `${activeMatchIndex + 1}/${total}`

  onMount(() => {
    observer = new MutationObserver(invalidate)
    if (root) observer.observe(root, {
      subtree: true, childList: true, characterData: true, attributes: true,
      attributeFilter: ['hidden', 'aria-hidden', 'inert', 'class', 'style', 'open'],
    })
    window.addEventListener('resize', invalidate)
    if (hasQuery) {
      refreshMatches()
      revealActive()
    }
    return () => {
      observer?.disconnect()
      window.removeEventListener('resize', invalidate)
    }
  })

  onDestroy(() => {
    disposed = true
    window.clearTimeout(searchTimeout)
    highlights.dispose()
  })

  function rememberReturnFocus() {
    returnFocus = rememberFocusReturn(bar) ?? returnFocus
  }

  // Short single-line text selected outside find becomes the query, as in
  // most editors. Longer selections are more likely a copy than a search.
  function selectedText() {
    const active = document.activeElement
    if (bar?.contains(active)) return ''
    const text = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement
      ? active.value.slice(active.selectionStart ?? 0, active.selectionEnd ?? 0)
      : window.getSelection()?.toString() ?? ''
    return text.trim() && text.length <= 100 && !/[\n\r]/.test(text) ? text.trim() : ''
  }

  export async function focus() {
    const seed = selectedText()
    rememberReturnFocus()
    if (seed && seed !== query) {
      query = seed
      scheduleFind(0)
    }
    await tick()
    if (disposed) return
    input?.focus({ preventScroll: true })
    input?.select()
  }

  export function close(restoreFocus = Boolean(bar?.contains(document.activeElement))) {
    // Only restore focus when leaving the bar itself. Closing after clicking
    // into a different editor must not send the caret back to the old one.
    if (restoreFocus) returnFocus?.restore()
    onClose()
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
    const sameQuery = searchedQuery === query
    const previous = sameQuery ? matchRanges[activeMatchIndex] : null
    const previousIndex = activeMatchIndex
    matchRanges = root ? findTextRanges(root, query) : []
    const retained = previous ? matchRanges.findIndex((range) =>
      range.startContainer === previous.startContainer && range.startOffset === previous.startOffset
      && range.endContainer === previous.endContainer && range.endOffset === previous.endOffset,
    ) : -1
    activeMatchIndex = !matchRanges.length ? -1 : retained >= 0 ? retained
      : sameQuery ? Math.min(Math.max(previousIndex, 0), matchRanges.length - 1) : firstVisibleFindIndex(matchRanges)
    searchedQuery = query
    dirty = false
    highlights.show(matchRanges, matchRanges[activeMatchIndex])
    return retained >= 0
  }

  function revealActive() {
    const range = matchRanges[activeMatchIndex]
    if (range) scrollFindRangeIntoView(range)
  }

  function scheduleFind(delay = 100) {
    window.clearTimeout(searchTimeout)
    searchTimeout = undefined
    dirty = true
    // Old matches go away at once; leaving them lit reads as a stale result.
    searchedQuery = ''
    matchRanges = []
    activeMatchIndex = -1
    highlights.show(matchRanges, undefined)
    if (composing) return
    if (!normalizeFindText(query).text.trim()) {
      searchedQuery = query
      return
    }
    searchTimeout = window.setTimeout(() => {
      searchTimeout = undefined
      refreshMatches()
      revealActive()
    }, delay)
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
      } else if (backwards) {
        activeMatchIndex = (activeMatchIndex - 1 + matchRanges.length) % matchRanges.length
      }
      highlights.setActive(matchRanges[activeMatchIndex])
      revealActive()
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

<div bind:this={bar} class="document-find" class:missing role="search" aria-label="Find in current view" on:pointerdown={rememberReturnFocus}>
  <input
    bind:this={input}
    type="text"
    enterkeyhint="search"
    aria-label="Find text"
    aria-describedby="document-find-status"
    placeholder="Find"
    autocomplete="off"
    autocapitalize="off"
    spellcheck={false}
    bind:value={query}
    on:input={(event) => { query = event.currentTarget.value; scheduleFind() }}
    on:compositionstart={() => { composing = true; window.clearTimeout(searchTimeout); searchTimeout = undefined }}
    on:compositionend={() => { composing = false; scheduleFind() }}
    on:keydown={handleKeydown}
  />
  <span id="document-find-status" class="find-status" role="status" aria-atomic="true">{status}</span>
  <span class="divider" aria-hidden="true"></span>
  <button type="button" title="Previous (⇧↩)" aria-label="Previous match" disabled={!hasQuery || missing} on:click={() => find(true)}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 14 6-6 6 6" /></svg>
  </button>
  <button type="button" title="Next (↩)" aria-label="Next match" disabled={!hasQuery || missing} on:click={() => find()}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m6 10 6 6 6-6" /></svg>
  </button>
  <button type="button" title="Close (Esc)" aria-label="Close find" on:click={() => close(true)}>
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" /></svg>
  </button>
</div>

<style>
  .document-find {
    position: fixed;
    z-index: 75;
    top: max(10px, env(safe-area-inset-top));
    right: 14px;
    width: min(340px, calc(100vw - 28px));
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 4px 4px 4px 12px;
    border: 1px solid var(--line-strong);
    border-radius: 10px;
    background: var(--paper-strong);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.16);
    animation: find-in 120ms ease-out;
  }

  .document-find:focus-within {
    border-color: var(--accent);
  }

  .document-find.missing {
    border-color: var(--danger);
  }

  input,
  input:focus {
    flex: 1;
    min-width: 0;
    padding: 6px 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
    outline: none;
  }

  .find-status {
    flex-shrink: 0;
    padding-inline: 6px;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }

  .missing .find-status {
    color: var(--danger);
  }

  .divider {
    flex-shrink: 0;
    width: 1px;
    height: 18px;
    margin-inline: 2px;
    background: var(--line-strong);
  }

  button {
    width: 28px;
    height: 28px;
    padding: 0;
    display: grid;
    place-items: center;
    flex-shrink: 0;
    border: 0;
    border-radius: 6px;
    background: transparent;
    box-shadow: none;
    color: var(--muted);
  }

  button:hover:not(:disabled) {
    background: color-mix(in srgb, var(--ink) 8%, transparent);
    color: var(--ink);
  }

  button:disabled {
    opacity: 0.4;
  }

  /* Browser find colors: every match yellow, the current one orange. Text
     stays dark so dark themes remain readable on the bright marks. */
  :global(::highlight(balance-document-find-all)) {
    background-color: rgba(255, 221, 0, 0.55);
    color: #1d1d1f;
  }

  :global(::highlight(balance-document-find-match)) {
    background-color: #ff9632;
    color: #1d1d1f;
  }

  @keyframes find-in {
    from {
      opacity: 0;
      transform: translateY(-4px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .document-find {
      animation: none;
    }
  }

  @media (max-width: 520px) {
    .document-find {
      right: 8px;
      width: calc(100vw - 16px);
    }
  }
</style>
