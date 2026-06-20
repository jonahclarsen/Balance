<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { escapeHTML, htmlToPlainText, isURL, sanitizeInlineHTML } from './planner'
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
  export let kind: 'plan' | 'template-option' | 'list-template-item'
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

  let editor: HTMLDivElement
  let renderedHTML = html || escapeHTML(text)
  let lastRevision = revision
  let savedSelection: SavedSelection | null = null
  let restoreSelectionOnNextFocus = false
  let restoreRequest = 0
  let pendingPasteInput = false

  $: {
    const nextHTML = html || escapeHTML(text)
    const revisionWasApplied = revision !== lastRevision

    if (revisionWasApplied) {
      lastRevision = revision
      renderedHTML = nextHTML
      if (editor) {
        editor.innerHTML = nextHTML
        if (editor === document.activeElement) focusTextInput(editor)
      }
    } else if (nextHTML !== renderedHTML && editor !== document.activeElement) {
      renderedHTML = nextHTML
      if (editor && sanitizeInlineHTML(editor.innerHTML) !== nextHTML) editor.innerHTML = nextHTML
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
    if (event.metaKey || event.ctrlKey) return

    event.preventDefault()
    await onArrowKey(event.key === 'ArrowUp' ? 'up' : 'down', event.currentTarget as HTMLDivElement, event)
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

    if (clipboardText && isURL(clipboardText) && hasNonCollapsedSelectionInside(activeEditor)) {
      event.preventDefault()
      pendingPasteInput = true
      document.execCommand('createLink', false, clipboardText.trim())
      persistPasteIfInputDidNotFire(activeEditor)
      return
    }

    if (clipboardHTML || clipboardText) {
      event.preventDefault()
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
    if (syncRenderedHTML) renderedHTML = nextHTML
    onChange(nextHTML, htmlToPlainText(nextHTML), options)
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
