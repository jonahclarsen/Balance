<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'
  import { escapeHTML, htmlToPlainText, isURL, sanitizeInlineHTML, type ItemLink, type ItemTextSegment } from './planner'
  import type { Id, MoveDirection } from './types'

  type HorizontalBoundaryDirection = 'left' | 'right'
  type SavedSelection = {
    start: number
    end: number
  }
  type TextChangeOptions = {
    mergeHistory?: boolean
  }

  export let html = ''
  export let text = ''
  export let inputId: Id
  export let kind: 'plan' | 'template-option' | 'list-template-item' | 'metric-question'
  export let className = ''
  export let done = false
  export let placeholder = ''
  export let ariaLabel = 'Text'
  export let revision = 0
  export let onChange: (html: string, text: string, options?: TextChangeOptions) => void
  export let onArrowKey:
    | ((direction: MoveDirection, editor: HTMLDivElement, event: KeyboardEvent) => void | Promise<void>)
    | null = null
  export let onSplit:
    | ((before: { html: string; text: string }, after: { html: string; text: string }, editor: HTMLDivElement) => void | Promise<void>)
    | null = null
  export let onBackspaceEmpty: ((editor: HTMLDivElement, event: KeyboardEvent) => void | Promise<void>) | null = null
  export let onBackspaceStart: ((editor: HTMLDivElement, event: KeyboardEvent) => void | Promise<void>) | null = null
  export let onMetaBackspaceEnd: ((editor: HTMLDivElement, event: KeyboardEvent) => void | Promise<void>) | null = null
  export let onHorizontalBoundaryKey:
    | ((direction: HorizontalBoundaryDirection, editor: HTMLDivElement, event: KeyboardEvent) => void | Promise<void>)
    | null = null
  export let onTabKey:
    | ((direction: 'in' | 'out', editor: HTMLDivElement, event: KeyboardEvent) => void | Promise<void>)
    | null = null
  export let onFocusChange: ((focused: boolean) => void) | null = null
  export let internalLinkSegments: ItemTextSegment[] = []
  export let onInternalLinkClick: ((link: ItemLink, event: MouseEvent) => void | Promise<void>) | null = null

  let editor: HTMLDivElement
  let renderedHTML = renderEditorHTML(html, text, internalLinkSegments)
  let lastRevision = revision
  let lastInternalLinkKey = internalLinkKey(internalLinkSegments)
  let savedSelection: SavedSelection | null = null
  let restoreSelectionOnNextFocus = false
  let restoreRequest = 0
  let pendingPasteInput = false

  onMount(() => {
    const listener = (event: Event) => handleProgrammaticPaste(event as CustomEvent<{ plainText: string | null; html: string | null }>)
    editor.addEventListener('balancepaste', listener)
    return () => editor.removeEventListener('balancepaste', listener)
  })

  $: {
    const nextInternalLinkKey = internalLinkKey(internalLinkSegments)
    const nextHTML = renderEditorHTML(html, text, internalLinkSegments)
    const revisionWasApplied = revision !== lastRevision

    if (revisionWasApplied) {
      lastRevision = revision
      lastInternalLinkKey = nextInternalLinkKey
      renderedHTML = nextHTML
      if (editor) {
        editor.innerHTML = nextHTML
        if (editor === document.activeElement) focusTextInput(editor)
      }
    } else if (nextInternalLinkKey !== lastInternalLinkKey && editor !== document.activeElement) {
      lastInternalLinkKey = nextInternalLinkKey
      renderedHTML = nextHTML
      if (editor && editor.innerHTML !== nextHTML) editor.innerHTML = nextHTML
    } else if (nextHTML !== renderedHTML && editor !== document.activeElement) {
      lastInternalLinkKey = nextInternalLinkKey
      renderedHTML = nextHTML
      if (editor && editor.innerHTML !== nextHTML) editor.innerHTML = nextHTML
    }
  }

  async function handleKeydown(event: KeyboardEvent) {
    const activeEditor = event.currentTarget as HTMLDivElement

    if (
      event.key === 'Backspace' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      onBackspaceStart &&
      isCaretAtStart(activeEditor)
    ) {
      event.preventDefault()
      await onBackspaceStart(activeEditor, event)
      return
    }

    if (
      event.key === 'Backspace' &&
      event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      onMetaBackspaceEnd &&
      isCaretAtEnd(activeEditor)
    ) {
      event.preventDefault()
      await onMetaBackspaceEnd(activeEditor, event)
      return
    }

    if (
      event.key === 'Backspace' &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      onBackspaceEmpty &&
      isEditorEmpty(activeEditor)
    ) {
      event.preventDefault()
      await onBackspaceEmpty(activeEditor, event)
      return
    }

    if (event.key === 'Tab' && !event.metaKey && !event.ctrlKey && !event.altKey && onTabKey) {
      event.preventDefault()
      await onTabKey(event.shiftKey ? 'out' : 'in', activeEditor, event)
      return
    }

    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
      if (event.shiftKey) {
        event.preventDefault()
        document.execCommand('insertLineBreak')
        persistEditor(activeEditor, false)
        return
      }

      if (onSplit) {
        event.preventDefault()
        const split = splitEditorAtSelection(activeEditor)
        const source = split.before.html === '' && split.before.text === '' ? split.after : split.before
        activeEditor.innerHTML = source.html
        renderedHTML = source.html
        await onSplit(split.before, split.after, activeEditor)
        return
      }
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'b') {
      event.preventDefault()
      document.execCommand('bold')
      persistEditor(event.currentTarget as HTMLDivElement, false)
      return
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'i') {
      event.preventDefault()
      document.execCommand('italic')
      persistEditor(event.currentTarget as HTMLDivElement, false)
      return
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'u') {
      event.preventDefault()
      document.execCommand('underline')
      persistEditor(event.currentTarget as HTMLDivElement, false)
      return
    }

    if (
      onHorizontalBoundaryKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey &&
      ((event.key === 'ArrowLeft' && isCaretAtStart(activeEditor)) ||
        (event.key === 'ArrowRight' && isCaretAtEnd(activeEditor)))
    ) {
      event.preventDefault()
      await onHorizontalBoundaryKey(event.key === 'ArrowLeft' ? 'left' : 'right', activeEditor, event)
      return
    }

    if (!onArrowKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    if (event.ctrlKey) return

    const direction = event.key === 'ArrowUp' ? 'up' : 'down'
    const alwaysMoveBetweenItems = event.metaKey || event.altKey || event.shiftKey
    if (!alwaysMoveBetweenItems && !isCaretOnBoundaryLine(activeEditor, direction)) return

    event.preventDefault()
    await onArrowKey(direction, activeEditor, event)
  }

  function isCaretOnBoundaryLine(activeEditor: HTMLDivElement, direction: MoveDirection) {
    const selection = document.getSelection()
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false

    const caretRange = selection.getRangeAt(0)
    if (!rangeIsInside(activeEditor, caretRange)) return false

    const contentRange = document.createRange()
    contentRange.selectNodeContents(activeEditor)
    const contentRects = Array.from(contentRange.getClientRects()).filter((rect) => rect.height > 0)
    if (contentRects.length === 0) return true

    const caretRect = caretLineRect(caretRange)
    // If the caret position can't be measured at all, treat it as being on the
    // boundary line so navigation isn't silently swallowed.
    if (!caretRect) return true

    const lineHeight = Number.parseFloat(getComputedStyle(activeEditor).lineHeight) || 20
    const tolerance = lineHeight * 0.4

    if (direction === 'up') {
      const firstLineTop = Math.min(...contentRects.map((rect) => rect.top))
      return caretRect.top <= firstLineTop + tolerance
    }

    const lastLineBottom = Math.max(...contentRects.map((rect) => rect.bottom))
    return caretRect.bottom >= lastLineBottom - tolerance
  }

  // A collapsed range resting on an element boundary — e.g. right after
  // focusTextInput() runs selectNodeContents()+collapse(), leaving the caret at
  // (editor, childCount) — reports an empty 0×0 rect in both Blink and WebKit.
  // That empty rect made vertical boundary detection misfire (down navigation
  // got stuck until an arrow key dropped the caret back into a text node, which
  // is why pressing Left/Right first "fixed" it). Re-anchor to the boundary
  // character so the caret's real line can always be measured.
  function caretLineRect(caretRange: Range): DOMRect | null {
    const direct = caretRange.getBoundingClientRect()
    if (direct.height > 0) return direct

    let node: Node = caretRange.startContainer
    let offset = caretRange.startOffset

    // Walk an element boundary down to the adjacent leaf node.
    while (node.nodeType === Node.ELEMENT_NODE) {
      const children: NodeListOf<ChildNode> = node.childNodes
      if (children.length === 0) break

      if (offset > 0) {
        const next = children[Math.min(offset, children.length) - 1]
        offset = next.nodeType === Node.TEXT_NODE ? next.textContent?.length ?? 0 : next.childNodes.length
        node = next
      } else {
        node = children[0]
        offset = 0
      }
    }

    if (node.nodeType !== Node.TEXT_NODE) return null

    const text = node as Text
    if (text.length === 0) return null

    const probe = document.createRange()
    if (offset >= text.length) {
      probe.setStart(text, text.length - 1)
      probe.setEnd(text, text.length)
    } else {
      probe.setStart(text, offset)
      probe.setEnd(text, offset + 1)
    }

    const rect = probe.getBoundingClientRect()
    return rect.height > 0 ? rect : null
  }

  function isEditorEmpty(activeEditor: HTMLDivElement) {
    return htmlToPlainText(sanitizeInlineHTML(activeEditor.innerHTML)).trim() === ''
  }

  function isCaretAtStart(activeEditor: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false

    const range = selection.getRangeAt(0)
    if (!rangeIsInside(activeEditor, range)) return false

    const beforeRange = document.createRange()
    beforeRange.selectNodeContents(activeEditor)
    beforeRange.setEnd(range.startContainer, range.startOffset)
    return htmlToPlainText(sanitizeFragment(beforeRange.cloneContents())) === ''
  }

  function isCaretAtEnd(activeEditor: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false

    const range = selection.getRangeAt(0)
    if (!rangeIsInside(activeEditor, range)) return false

    const afterRange = document.createRange()
    afterRange.selectNodeContents(activeEditor)
    afterRange.setStart(range.startContainer, range.startOffset)
    return htmlToPlainText(sanitizeFragment(afterRange.cloneContents())) === ''
  }

  function handleInput(event: Event) {
    const activeEditor = event.currentTarget as HTMLDivElement
    const mergeHistory = !pendingPasteInput
    pendingPasteInput = false
    persistEditor(activeEditor, false, { mergeHistory })
    saveSelection(activeEditor)
  }

  function handleFocus() {
    onFocusChange?.(true)
    if (!restoreSelectionOnNextFocus) return

    scheduleSelectionRestore()
  }

  function handleBlur() {
    if (!editor) return

    onFocusChange?.(false)
    saveSelection(editor)
    // persistEditor below may rewrite innerHTML to its normalized form (when the user just
    // typed un-normalized content). That rewrite collapses the live selection to offset 0 and
    // fires a selectionchange. Arm the restore guard first so handleDocumentSelectionChange
    // can't overwrite the caret we just saved. If this blur is only an in-document focus move
    // (the app still has focus), back the guard out once we can observe the real focus state.
    restoreSelectionOnNextFocus = true
    persistEditor(editor)
    queueMicrotask(() => {
      if (document.hasFocus() && editor !== document.activeElement) restoreSelectionOnNextFocus = false
    })
  }

  function handleWindowFocus() {
    if (restoreSelectionOnNextFocus) scheduleSelectionRestore()
  }

  function handleWindowBlur() {
    if (editor !== document.activeElement) return

    // If handleBlur already armed the restore, it captured the caret before persistEditor could
    // collapse it — don't re-read a possibly-collapsed selection here.
    if (!restoreSelectionOnNextFocus) saveSelection(editor)
    restoreSelectionOnNextFocus = true
  }

  function handleDocumentSelectionChange() {
    if (restoreSelectionOnNextFocus) return
    if (editor) saveSelection(editor)
  }

  function handleDocumentVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      if (editor === document.activeElement) {
        saveSelection(editor)
        restoreSelectionOnNextFocus = true
      }
      return
    }

    if (restoreSelectionOnNextFocus) scheduleSelectionRestore()
  }

  function handlePaste(event: ClipboardEvent) {
    const activeEditor = event.currentTarget as HTMLDivElement
    const clipboardText = event.clipboardData?.getData('text/plain') ?? ''
    const clipboardHTML = event.clipboardData?.getData('text/html') ?? ''

    if (!clipboardHTML && !clipboardText) return
    event.preventDefault()
    insertClipboardContents(activeEditor, clipboardText, clipboardHTML)
  }

  function handleProgrammaticPaste(event: CustomEvent<{ plainText: string | null; html: string | null }>) {
    if (!editor) return
    insertClipboardContents(editor, event.detail.plainText ?? '', event.detail.html ?? '')
  }

  function insertClipboardContents(activeEditor: HTMLDivElement, clipboardText: string, clipboardHTML: string) {

    if (clipboardText && isURL(clipboardText) && hasNonCollapsedSelectionInside(activeEditor)) {
      pendingPasteInput = true
      document.execCommand('createLink', false, clipboardText.trim())
      persistPasteIfInputDidNotFire(activeEditor)
      return
    }

    if (clipboardHTML || clipboardText) {
      const trimmedText = clipboardText.trim()
      let pastedHTML = clipboardHTML
        ? sanitizeInlineHTML(clipboardHTML)
        : escapeHTML(clipboardText).replace(/\r?\n/g, '<br>')
      if (!clipboardHTML && isURL(trimmedText)) {
        const url = escapeHTML(trimmedText)
        pastedHTML = `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`
      }
      pendingPasteInput = true
      document.execCommand('insertHTML', false, pastedHTML)
      persistPasteIfInputDidNotFire(activeEditor)
    }
  }

  async function handleClick(event: MouseEvent) {
    const target = event.target instanceof Node ? event.target : null
    const anchor =
      target instanceof Element
        ? target.closest<HTMLAnchorElement>('a[href]')
        : target?.parentElement?.closest<HTMLAnchorElement>('a[href]') ?? null
    if (!anchor || !editor?.contains(anchor)) return

    const internalLink = itemLinkFromAnchor(anchor)
    if (internalLink && onInternalLinkClick) {
      event.preventDefault()
      event.stopPropagation()
      await onInternalLinkClick(internalLink, event)
      return
    }

    const href = anchor.href
    if (!isURL(href)) return

    event.preventDefault()
    event.stopPropagation()

    if (isTauri()) {
      await invoke('open_external_url', { url: href })
      return
    }

    window.open(href, '_blank', 'noopener,noreferrer')
  }

  function persistPasteIfInputDidNotFire(activeEditor: HTMLDivElement) {
    if (!pendingPasteInput) return

    pendingPasteInput = false
    persistEditor(activeEditor, false, { mergeHistory: false })
    saveSelection(activeEditor)
  }

  function persistEditor(activeEditor: HTMLDivElement, syncRenderedHTML = true, options: TextChangeOptions = {}) {
    const nextHTML = sanitizeInlineHTML(activeEditor.innerHTML)
    if (syncRenderedHTML && activeEditor.innerHTML !== nextHTML) activeEditor.innerHTML = nextHTML
    const nextText = htmlToPlainText(nextHTML)
    if (syncRenderedHTML) {
      renderedHTML = renderEditorHTML(nextHTML, nextText, internalLinkSegments)
      if (activeEditor.innerHTML !== renderedHTML) activeEditor.innerHTML = renderedHTML
    }
    onChange(nextHTML, nextText, options)
  }

  function renderEditorHTML(sourceHTML: string, sourceText: string, segments: ItemTextSegment[]) {
    const fallbackHTML = sourceHTML || escapeHTML(sourceText)
    if (!canRenderInternalLinks(sourceHTML, sourceText, segments)) return fallbackHTML

    return segments
      .map((segment) => {
        if (!segment.link) return escapeHTML(segment.text)
        return `<a href="#" data-internal-link-kind="${segment.link.kind}" data-internal-link-id="${escapeHTML(
          internalLinkId(segment.link),
        )}" data-internal-link-label="${escapeHTML(segment.link.label)}" title="Open ${escapeHTML(segment.link.label)}">${escapeHTML(
          segment.text,
        )}</a>`
      })
      .join('')
  }

  function canRenderInternalLinks(sourceHTML: string, sourceText: string, segments: ItemTextSegment[]) {
    if (!segments.some((segment) => segment.link)) return false
    const fallbackHTML = sourceHTML || escapeHTML(sourceText)
    return sanitizeInlineHTML(fallbackHTML) === escapeHTML(sourceText)
  }

  function internalLinkKey(segments: ItemTextSegment[]) {
    return segments
      .map((segment) => `${segment.text}:${segment.link ? `${segment.link.kind}:${internalLinkId(segment.link)}:${segment.link.label}` : ''}`)
      .join('|')
  }

  function internalLinkId(link: ItemLink) {
    return link.kind === 'list' ? link.listTemplateId : link.metricId
  }

  function itemLinkFromAnchor(anchor: HTMLAnchorElement): ItemLink | null {
    const kind = anchor.dataset.internalLinkKind
    const id = anchor.dataset.internalLinkId
    const label = anchor.dataset.internalLinkLabel ?? anchor.textContent ?? ''

    if (kind === 'list' && id) return { kind, listTemplateId: id, label }
    if (kind === 'metric' && id) return { kind, metricId: id, label }
    return null
  }

  function hasNonCollapsedSelectionInside(activeEditor: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false

    const range = selection.getRangeAt(0)
    return activeEditor.contains(range.commonAncestorContainer)
  }

  function splitEditorAtSelection(activeEditor: HTMLDivElement) {
    // When there is no usable selection inside the editor (which can happen on a freshly created
    // item whose caret was momentarily dropped), fall back to splitting at the end of the content
    // so Enter still creates a new sibling instead of inserting a newline.
    const selection = document.getSelection()
    const liveRange = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
    const range = liveRange && rangeIsInside(activeEditor, liveRange) ? liveRange : selectionRangeAtEnd(activeEditor)

    if (!range.collapsed) {
      range.deleteContents()
      range.collapse(true)
    }

    const beforeRange = document.createRange()
    beforeRange.selectNodeContents(activeEditor)
    beforeRange.setEnd(range.startContainer, range.startOffset)

    const afterRange = document.createRange()
    afterRange.selectNodeContents(activeEditor)
    afterRange.setStart(range.startContainer, range.startOffset)

    const beforeHTML = sanitizeFragment(beforeRange.cloneContents())
    const afterHTML = sanitizeFragment(afterRange.cloneContents())

    return {
      before: { html: beforeHTML, text: htmlToPlainText(beforeHTML) },
      after: { html: afterHTML, text: htmlToPlainText(afterHTML) },
    }
  }

  function selectionRangeAtEnd(activeEditor: HTMLDivElement) {
    const range = document.createRange()
    range.selectNodeContents(activeEditor)
    range.collapse(false)
    return range
  }

  function sanitizeFragment(fragment: DocumentFragment) {
    const container = document.createElement('div')
    container.append(fragment)
    return sanitizeInlineHTML(container.innerHTML)
  }

  function rangeIsInside(activeEditor: HTMLDivElement, range: Range) {
    return activeEditor.contains(range.startContainer) && activeEditor.contains(range.endContainer)
  }

  function saveSelection(activeEditor: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return

    const range = selection.getRangeAt(0)
    if (!rangeIsInside(activeEditor, range)) return

    savedSelection = {
      start: textOffsetForRangeBoundary(activeEditor, range.startContainer, range.startOffset),
      end: textOffsetForRangeBoundary(activeEditor, range.endContainer, range.endOffset),
    }
  }

  function restoreSelection(activeEditor: HTMLDivElement) {
    if (!savedSelection) return

    const range = document.createRange()
    const start = domPositionForTextOffset(activeEditor, savedSelection.start)
    const end = domPositionForTextOffset(activeEditor, savedSelection.end)
    range.setStart(start.node, start.offset)
    range.setEnd(end.node, end.offset)

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  function scheduleSelectionRestore() {
    const request = ++restoreRequest
    restoreSelectionOnNextFocus = true

    requestAnimationFrame(() => restoreSelectionForRequest(request, false))
    window.setTimeout(() => restoreSelectionForRequest(request, false), 0)
    window.setTimeout(() => restoreSelectionForRequest(request, true), 75)
  }

  function restoreSelectionForRequest(request: number, finalAttempt: boolean) {
    if (request !== restoreRequest) return

    if (editor !== document.activeElement) return

    restoreSelection(editor)
    if (finalAttempt) restoreSelectionOnNextFocus = false
  }

  function textOffsetForRangeBoundary(activeEditor: HTMLDivElement, boundaryNode: Node, boundaryOffset: number) {
    const range = document.createRange()
    range.selectNodeContents(activeEditor)
    range.setEnd(boundaryNode, boundaryOffset)
    return range.toString().length
  }

  function domPositionForTextOffset(activeEditor: HTMLDivElement, offset: number) {
    const walker = document.createTreeWalker(activeEditor, NodeFilter.SHOW_TEXT)
    let remaining = offset
    let node = walker.nextNode()

    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) return { node, offset: remaining }

      remaining -= length
      node = walker.nextNode()
    }

    return { node: activeEditor, offset: activeEditor.childNodes.length }
  }

  function focusTextInput(input: HTMLDivElement) {
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
</script>

<svelte:window on:blur={handleWindowBlur} on:focus={handleWindowFocus} />
<svelte:document on:selectionchange={handleDocumentSelectionChange} on:visibilitychange={handleDocumentVisibilityChange} />

<div
  bind:this={editor}
  class={className}
  class:done
  data-rich-text-input
  data-rich-text-kind={kind}
  data-rich-text-input-id={inputId}
  data-plan-text-input={kind === 'plan' ? '' : undefined}
  data-plan-text-input-id={kind === 'plan' ? inputId : undefined}
  data-plan-text-focus-target={kind === 'plan' ? '' : undefined}
  data-plan-text-focus-target-id={kind === 'plan' ? inputId : undefined}
  data-template-option-text-input={kind === 'template-option' ? '' : undefined}
  data-template-option-text-input-id={kind === 'template-option' ? inputId : undefined}
  data-list-template-text-input={kind === 'list-template-item' ? '' : undefined}
  data-list-template-text-input-id={kind === 'list-template-item' ? inputId : undefined}
  contenteditable="true"
  role="textbox"
  tabindex="0"
  aria-label={ariaLabel}
  data-placeholder={placeholder}
  on:blur={handleBlur}
  on:focus={handleFocus}
  on:keydown={handleKeydown}
  on:click={handleClick}
  on:input={handleInput}
  on:paste={handlePaste}
>{@html renderedHTML}</div>
