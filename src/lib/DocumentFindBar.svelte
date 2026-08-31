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
  let matchRanges: Range[] = []
  let activeMatchIndex = -1
  let highlightRects: Array<{ top: number; left: number; width: number; height: number }> = []

  const highlightName = 'balance-document-find-match'

  onMount(() => {
    void focus()
    window.addEventListener('scroll', updateHighlightRects, true)
    window.addEventListener('resize', updateHighlightRects)
    return () => {
      window.removeEventListener('scroll', updateHighlightRects, true)
      window.removeEventListener('resize', updateHighlightRects)
    }
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
    matchRanges = []
    activeMatchIndex = -1
    highlightRects = []
    CSS.highlights.delete(highlightName)
  }

  function findTextRanges(searchQuery: string): Range[] {
    type TextPiece = { node: Text; start: number; end: number }
    type TextRun = { block: Element; text: string; pieces: TextPiece[] }

    const runs: TextRun[] = []
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        const text = node instanceof Text ? node : null
        const parent = text?.parentElement
        if (!text?.data || !parent) return NodeFilter.FILTER_REJECT
        if (parent.closest('.document-find, .find-match-overlay, script, style, noscript, [hidden], [aria-hidden="true"]')) {
          return NodeFilter.FILTER_REJECT
        }

        const range = document.createRange()
        range.selectNodeContents(text)
        return range.getClientRects().length > 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT
      },
    })

    let node = walker.nextNode()
    while (node) {
      const text = node as Text
      const block = textBlock(text)
      if (block) {
        let run = runs.at(-1)
        if (!run || run.block !== block) {
          run = { block, text: '', pieces: [] }
          runs.push(run)
        }
        const start = run.text.length
        run.text += text.data
        run.pieces.push({ node: text, start, end: run.text.length })
      }
      node = walker.nextNode()
    }

    const needle = searchQuery.toLocaleLowerCase()
    const ranges: Range[] = []
    for (const run of runs) {
      const haystack = run.text.toLocaleLowerCase()
      let matchStart = haystack.indexOf(needle)
      while (matchStart !== -1) {
        const matchEnd = matchStart + needle.length
        const startPiece = run.pieces.find((piece) => matchStart >= piece.start && matchStart < piece.end)
        const endPiece = run.pieces.find((piece) => matchEnd > piece.start && matchEnd <= piece.end)
        if (startPiece && endPiece) {
          const range = document.createRange()
          range.setStart(startPiece.node, matchStart - startPiece.start)
          range.setEnd(endPiece.node, matchEnd - endPiece.start)
          ranges.push(range)
        }
        matchStart = haystack.indexOf(needle, matchEnd)
      }
    }
    return ranges
  }

  function textBlock(text: Text): Element | null {
    let element = text.parentElement
    const fallback = element
    while (element && element !== document.body) {
      const display = window.getComputedStyle(element).display
      if (display !== 'contents' && !display.startsWith('inline')) return element
      element = element.parentElement
    }
    return fallback
  }

  function updateHighlightRects() {
    if (
      !highlightedRange?.startContainer.isConnected
      || !highlightedRange.endContainer.isConnected
    ) {
      if (highlightRects.length > 0) highlightRects = []
      return
    }

    highlightRects = Array.from(highlightedRange.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .map((rect) => ({
        top: Math.max(0, rect.top),
        left: Math.max(0, rect.left),
        width: Math.max(0, Math.min(window.innerWidth, rect.right) - Math.max(0, rect.left)),
        height: Math.max(0, Math.min(window.innerHeight, rect.bottom) - Math.max(0, rect.top)),
      }))
      .filter((rect) => rect.width > 0 && rect.height > 0)
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

    const canReuseMatches = highlightedQuery === query
      && matchRanges.length > 0
      && matchRanges.every((range) => range.startContainer.isConnected && range.endContainer.isConnected)
    if (!canReuseMatches) {
      matchRanges = findTextRanges(query)
      activeMatchIndex = -1
    }

    found = matchRanges.length > 0
    highlightedQuery = query
    if (found) {
      activeMatchIndex = activeMatchIndex === -1
        ? (backwards ? matchRanges.length - 1 : 0)
        : (activeMatchIndex + (backwards ? -1 : 1) + matchRanges.length) % matchRanges.length
      highlightedRange = matchRanges[activeMatchIndex]
    } else {
      activeMatchIndex = -1
      highlightedRange = null
      highlightRects = []
    }

    CSS.highlights.delete(highlightName)
    if (highlightedRange) {
      CSS.highlights.set(highlightName, new Highlight(highlightedRange))
      scrollRangeIntoView(highlightedRange)
      updateHighlightRects()
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

{#each highlightRects as rect}
  <span
    class="find-match-overlay"
    aria-hidden="true"
    style={`top: ${rect.top}px; left: ${rect.left}px; width: ${rect.width}px; height: ${rect.height}px;`}
  ></span>
{/each}

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
    {found === false ? 'No matches' : found === true ? `${activeMatchIndex + 1}/${matchRanges.length} matches` : ''}
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
    text-align: center;
  }

  .find-match-overlay {
    position: fixed;
    z-index: 74;
    border-radius: 2px;
    background-color: color-mix(in srgb, var(--accent) 32%, transparent);
    box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--accent) 48%, transparent);
    pointer-events: none;
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
