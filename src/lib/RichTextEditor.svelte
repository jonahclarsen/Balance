<script lang="ts">
  import { onMount } from 'svelte'
  import { openExternalURL } from './externalLinks'
  import {
    escapeHTML,
    htmlToPlainText,
    internalLinkId,
    isURL,
    itemLinkFromAnchor,
    linkifyExternalURLs,
    noteIdFromURL,
    renderItemDisplayHTML,
    sanitizeInlineHTML,
    type ItemLink,
    type ItemTextSegment,
  } from './planner'
  import type { Id, MoveDirection } from './types'

  type HorizontalBoundaryDirection = 'left' | 'right'
  type InlineFormatCommand = 'bold' | 'italic' | 'underline'
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
  export let kind: 'plan' | 'template-option' | 'list-template-item' | 'metric-question' | 'goal-name' | 'goal-match-terms' | 'note'
  export let className = ''
  export let done = false
  export let singleLine = false
  export let placeholder = ''
  export let ariaLabel = 'Text'
  export let revision = 0
  export let onChange: (html: string, text: string, options?: TextChangeOptions, editor?: HTMLDivElement) => void
  export let onArrowKey:
    | ((direction: MoveDirection, editor: HTMLDivElement, event: KeyboardEvent) => void | Promise<void>)
    | null = null
  export let interceptShiftArrow = false
  export let interceptShiftArrowAtBoundary = false
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
  export let onBeforeInput: ((editor: HTMLDivElement, event: InputEvent) => void) | null = null
  export let onKeyDown: ((editor: HTMLDivElement, event: KeyboardEvent) => void) | null = null
  export let internalLinkSegments: ItemTextSegment[] = []
  export let onInternalLinkClick: ((link: ItemLink, event: MouseEvent) => void | Promise<void>) | null = null

  let editor: HTMLDivElement
  let renderedHTML = renderEditorHTML(html, text, internalLinkSegments)
  let lastRevision = revision
  let lastInternalLinkKey = internalLinkKey(internalLinkSegments)
  let savedSelection: SavedSelection | null = null
  let lastInteractionSelection: SavedSelection | null = null
  let editorBlurPendingWindowOutcome = false
  let restoreSelectionOnNextFocus = false
  let windowBlurred = false
  let restoreRequest = 0
  let pendingPasteInput = false

  onMount(() => {
    const pasteListener = (event: Event) => handleProgrammaticPaste(event as CustomEvent<{ plainText: string | null; html: string | null }>)
    const formatListener = (event: Event) => handleProgrammaticFormat(event as CustomEvent<{ command: InlineFormatCommand }>)
    editor.addEventListener('balancepaste', pasteListener)
    editor.addEventListener('balanceformat', formatListener)
    return () => {
      editor.removeEventListener('balancepaste', pasteListener)
      editor.removeEventListener('balanceformat', formatListener)
    }
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

    if (onKeyDown) {
      onKeyDown(activeEditor, event)
      if (event.defaultPrevented) return
    }

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
      if (singleLine) {
        event.preventDefault()
        return
      }

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
      toggleInlineFormat(activeEditor, 'bold')
      return
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'i') {
      event.preventDefault()
      toggleInlineFormat(activeEditor, 'italic')
      return
    }

    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.key.toLowerCase() === 'u') {
      event.preventDefault()
      toggleInlineFormat(activeEditor, 'underline')
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
    let navigationEditor = activeEditor
    if (event.shiftKey && !event.metaKey && !event.altKey && !interceptShiftArrow) {
      if (!interceptShiftArrowAtBoundary) return
      navigationEditor = selectionFocusEditor(activeEditor)
      if (!isSelectionFocusOnBoundaryLine(navigationEditor, direction)) return
    }
    const alwaysMoveBetweenItems = event.metaKey || event.altKey || event.shiftKey
    if (!alwaysMoveBetweenItems && !isCaretOnBoundaryLine(activeEditor, direction)) return

    event.preventDefault()
    await onArrowKey(direction, navigationEditor, event)
  }

  function selectionFocusEditor(fallback: HTMLDivElement) {
    const focusNode = document.getSelection()?.focusNode
    const focusElement = focusNode instanceof Element ? focusNode : focusNode?.parentElement
    return focusElement?.closest<HTMLDivElement>('[data-rich-text-input]') ?? fallback
  }

  function isSelectionFocusOnBoundaryLine(activeEditor: HTMLDivElement, direction: MoveDirection) {
    const selection = document.getSelection()
    if (!selection?.focusNode || !activeEditor.contains(selection.focusNode)) return false

    // A non-collapsed selection carries visual affinity that a bare DOM point
    // does not. At a soft-wrap boundary, the same text offset represents both
    // the end of the preceding visual line and the start of the next one.
    // Collapsing a forward selection at that offset makes the browser report
    // the next line, even though the visible selection ends on the preceding
    // line. Use the first/last painted selection rect while both endpoints are
    // in this editor so boundary navigation follows the endpoint the user sees.
    if (
      !selection.isCollapsed &&
      selection.rangeCount > 0 &&
      selection.anchorNode &&
      activeEditor.contains(selection.anchorNode)
    ) {
      const focusRect = visualSelectionFocusRect(selection)
      if (focusRect) return isRectOnBoundaryLine(activeEditor, focusRect, direction)
    }

    const focusRange = document.createRange()
    focusRange.setStart(selection.focusNode, selection.focusOffset)
    focusRange.collapse(true)
    return isRangeOnBoundaryLine(activeEditor, focusRange, direction)
  }

  function visualSelectionFocusRect(selection: Selection): DOMRect | null {
    const range = selection.getRangeAt(0)
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.height > 0 && rect.width > 0)
    if (rects.length === 0) return null

    const focusIsRangeStart =
      range.startContainer === selection.focusNode && range.startOffset === selection.focusOffset
    return focusIsRangeStart ? rects[0] : rects[rects.length - 1]
  }

  function isCaretOnBoundaryLine(activeEditor: HTMLDivElement, direction: MoveDirection) {
    const selection = document.getSelection()
    if (!selection || !selection.isCollapsed || selection.rangeCount === 0) return false

    const caretRange = selection.getRangeAt(0)
    if (!rangeIsInside(activeEditor, caretRange)) return false

    return isRangeOnBoundaryLine(activeEditor, caretRange, direction)
  }

  function isRangeOnBoundaryLine(activeEditor: HTMLDivElement, caretRange: Range, direction: MoveDirection) {
    const caretRect = caretLineRect(caretRange)
    // If the caret position can't be measured at all, treat it as being on the
    // boundary line so navigation isn't silently swallowed.
    if (!caretRect) return true

    return isRectOnBoundaryLine(activeEditor, caretRect, direction)
  }

  function isRectOnBoundaryLine(activeEditor: HTMLDivElement, caretRect: DOMRect, direction: MoveDirection) {
    const contentRange = document.createRange()
    contentRange.selectNodeContents(activeEditor)
    const contentRects = Array.from(contentRange.getClientRects()).filter((rect) => rect.height > 0)
    if (contentRects.length === 0) return true

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

    if (node.nodeType !== Node.TEXT_NODE) return caretMarkerRect(caretRange)

    const text = node as Text
    if (text.length === 0) return caretMarkerRect(caretRange)

    const probe = document.createRange()
    if (offset >= text.length) {
      probe.setStart(text, text.length - 1)
      probe.setEnd(text, text.length)
    } else {
      probe.setStart(text, offset)
      probe.setEnd(text, offset + 1)
    }

    const rect = probe.getBoundingClientRect()
    return rect.height > 0 ? rect : caretMarkerRect(caretRange)
  }

  // A genuinely empty visual line has no adjacent text character to probe. Insert a
  // zero-width marker just long enough to measure that line, then restore the exact
  // collapsed selection. No input event is emitted, so the marker is never persisted.
  function caretMarkerRect(caretRange: Range): DOMRect | null {
    const container = caretRange.startContainer
    const offset = caretRange.startOffset
    if (container.nodeType !== Node.ELEMENT_NODE || (container as Element).matches('br, img')) return null

    const marker = document.createElement('span')
    marker.textContent = '\u200b'

    const probe = caretRange.cloneRange()
    probe.insertNode(marker)
    const measured = marker.getBoundingClientRect()
    marker.remove()

    const restored = document.createRange()
    restored.setStart(container, offset)
    restored.collapse(true)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(restored)

    return measured.height > 0 ? measured : null
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
    lastInteractionSelection = saveSelection(activeEditor)
  }

  function handleBeforeInput(event: InputEvent) {
    onBeforeInput?.(event.currentTarget as HTMLDivElement, event)
  }

  function handleKeyup(event: KeyboardEvent) {
    if (windowBlurred || editorBlurPendingWindowOutcome || restoreSelectionOnNextFocus) return
    lastInteractionSelection = saveSelection(event.currentTarget as HTMLDivElement)
  }

  function handlePointerup(event: PointerEvent) {
    if (windowBlurred || editorBlurPendingWindowOutcome || restoreSelectionOnNextFocus) return
    lastInteractionSelection = saveSelection(event.currentTarget as HTMLDivElement)
  }

  function handleFocus() {
    onFocusChange?.(true)
    if (!restoreSelectionOnNextFocus) return

    scheduleSelectionRestore()
  }

  function handleBlur() {
    if (!editor) return

    onFocusChange?.(false)
    // Input, keyup, and pointerup save a trusted caret while the user is still interacting with
    // the editor. Some native webviews collapse the live DOM selection to offset 0 before
    // delivering editor blur, so reading it here would overwrite that good position.
    // Guard the saved caret until focusin proves this was an in-app move or window blur confirms
    // that the app lost focus. The two blur events may arrive in separate tasks.
    editorBlurPendingWindowOutcome = !restoreSelectionOnNextFocus && !windowBlurred
    persistEditor(editor)
  }

  function handleWindowFocus() {
    windowBlurred = false
    if (restoreSelectionOnNextFocus) scheduleSelectionRestore()
  }

  function handleWindowBlur() {
    if (editor !== document.activeElement && !editorBlurPendingWindowOutcome) return

    windowBlurred = true
    editorBlurPendingWindowOutcome = false
    useLastInteractionSelection()
    restoreSelectionOnNextFocus = true
  }

  function handleDocumentSelectionChange() {
    if (editorBlurPendingWindowOutcome || restoreSelectionOnNextFocus) return
    if (editor === document.activeElement) saveSelection(editor)
  }

  function handleDocumentInteraction() {
    // If the editor was deliberately blurred and the user keeps working inside Balance, it was
    // not an app switch. This also clears pending state when the new target is not focusable.
    if (!windowBlurred && !restoreSelectionOnNextFocus) editorBlurPendingWindowOutcome = false
  }

  function handleDocumentVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      windowBlurred = true
      if (editor === document.activeElement || editorBlurPendingWindowOutcome) {
        editorBlurPendingWindowOutcome = false
        useLastInteractionSelection()
        restoreSelectionOnNextFocus = true
      }
      return
    }

    windowBlurred = false
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

  function handleProgrammaticFormat(event: CustomEvent<{ command: InlineFormatCommand }>) {
    if (!editor || !['bold', 'italic', 'underline'].includes(event.detail.command)) return
    toggleInlineFormat(editor, event.detail.command)
  }

  function toggleInlineFormat(activeEditor: HTMLDivElement, command: InlineFormatCommand) {
    document.execCommand(command)
    persistEditor(activeEditor, false)
  }

  function insertClipboardContents(activeEditor: HTMLDivElement, clipboardText: string, clipboardHTML: string) {

    if (clipboardText && (isURL(clipboardText) || noteIdFromURL(clipboardText)) && hasNonCollapsedSelectionInside(activeEditor)) {
      pendingPasteInput = true
      document.execCommand('createLink', false, clipboardText.trim())
      persistPasteIfInputDidNotFire(activeEditor)
      return
    }

    if (clipboardHTML || clipboardText) {
      let pastedHTML = linkifyExternalURLs(
        clipboardHTML ? clipboardHTML : escapeHTML(clipboardText).replace(/\r?\n/g, '<br>'),
      )
      if (singleLine) pastedHTML = pastedHTML.replace(/<br>/g, ' ')
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

    await openExternalURL(href)
  }

  function persistPasteIfInputDidNotFire(activeEditor: HTMLDivElement) {
    if (!pendingPasteInput) return

    pendingPasteInput = false
    persistEditor(activeEditor, false, { mergeHistory: false })
    lastInteractionSelection = saveSelection(activeEditor)
  }

  function persistEditor(activeEditor: HTMLDivElement, syncRenderedHTML = true, options: TextChangeOptions = {}) {
    const sanitizedHTML = sanitizeInlineHTMLWithoutCaretPlaceholder(activeEditor)
    const nextHTML = sanitizedHTML.trim() === '' ? '' : sanitizedHTML
    if (activeEditor.innerHTML !== nextHTML && (syncRenderedHTML || nextHTML === '')) {
      activeEditor.innerHTML = nextHTML
      if (activeEditor === document.activeElement) focusTextInput(activeEditor)
    }
    const nextText = htmlToPlainText(nextHTML)
    if (syncRenderedHTML) {
      renderedHTML = renderEditorHTML(nextHTML, nextText, internalLinkSegments)
      if (activeEditor.innerHTML !== renderedHTML) activeEditor.innerHTML = renderedHTML
    }
    onChange(nextHTML, nextText, options, activeEditor)
  }

  function renderEditorHTML(sourceHTML: string, sourceText: string, segments: ItemTextSegment[]) {
    const displayHTML = renderItemDisplayHTML(sourceHTML, sourceText, segments)
    if (!displayHTML || !endsWithLineBreak(displayHTML)) return displayHTML

    // A final semantic <br> needs one additional contenteditable-only <br> so
    // the browser gives its empty line height and a caret position. This extra
    // break is removed again before persistence.
    return `${displayHTML}<br>`
  }

  function sanitizeInlineHTMLWithoutCaretPlaceholder(activeEditor: HTMLDivElement) {
    const clone = activeEditor.cloneNode(true) as HTMLDivElement
    if ((clone.textContent ?? '').trim() !== '') removeLastLineBreak(clone)
    return sanitizeInlineHTML(clone.innerHTML)
  }

  function endsWithLineBreak(value: string) {
    const template = document.createElement('template')
    template.innerHTML = value
    return lastRenderedNodeIsLineBreak(template.content)
  }

  function lastRenderedNodeIsLineBreak(parent: ParentNode): boolean {
    for (let node = parent.lastChild; node; node = node.previousSibling) {
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '') === '') continue
      if (node.nodeName === 'BR') return true
      return node.nodeType === Node.ELEMENT_NODE && lastRenderedNodeIsLineBreak(node as unknown as ParentNode)
    }
    return false
  }

  function removeLastLineBreak(parent: ParentNode): boolean {
    for (let node = parent.lastChild; node; node = node.previousSibling) {
      if (node.nodeType === Node.TEXT_NODE && (node.textContent ?? '') === '') continue
      if (node.nodeName === 'BR') {
        node.remove()
        return true
      }
      return node.nodeType === Node.ELEMENT_NODE && removeLastLineBreak(node as unknown as ParentNode)
    }
    return false
  }

  function internalLinkKey(segments: ItemTextSegment[]) {
    return segments
      .map((segment) => `${segment.text}:${segment.link ? `${segment.link.kind}:${internalLinkId(segment.link)}:${segment.link.label}` : ''}`)
      .join('|')
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

  function saveSelection(activeEditor: HTMLDivElement): SavedSelection | null {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return null

    const range = selection.getRangeAt(0)
    if (!rangeIsInside(activeEditor, range)) return null

    const nextSelection = {
      start: textOffsetForRangeBoundary(activeEditor, range.startContainer, range.startOffset),
      end: textOffsetForRangeBoundary(activeEditor, range.endContainer, range.endOffset),
    }
    savedSelection = nextSelection
    return nextSelection
  }

  function useLastInteractionSelection() {
    if (!lastInteractionSelection) return
    savedSelection = { ...lastInteractionSelection }
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
<svelte:document
  on:focusin={handleDocumentInteraction}
  on:keydown={handleDocumentInteraction}
  on:pointerup={handleDocumentInteraction}
  on:selectionchange={handleDocumentSelectionChange}
  on:visibilitychange={handleDocumentVisibilityChange}
/>

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
  data-metric-question-text-input={kind === 'metric-question' ? '' : undefined}
  data-metric-question-text-input-id={kind === 'metric-question' ? inputId : undefined}
  data-note-text-input={kind === 'note' ? '' : undefined}
  data-note-text-input-id={kind === 'note' ? inputId : undefined}
  contenteditable="true"
  role="textbox"
  tabindex="0"
  aria-label={ariaLabel}
  data-placeholder={placeholder}
  on:blur={handleBlur}
  on:focus={handleFocus}
  on:beforeinput={handleBeforeInput}
  on:keydown={handleKeydown}
  on:keyup={handleKeyup}
  on:click={handleClick}
  on:input={handleInput}
  on:paste={handlePaste}
  on:pointerup={handlePointerup}
>{@html renderedHTML}</div>
