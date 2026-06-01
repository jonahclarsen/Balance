<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { escapeHTML, htmlToPlainText, isURL, sanitizeInlineHTML } from './planner'
  import type { Id, MoveDirection } from './types'

  type HorizontalBoundaryDirection = 'left' | 'right'
  type SavedSelection = {
    start: number
    end: number
  }

  export let html = ''
  export let text = ''
  export let inputId: Id
  export let kind: 'plan' | 'template-option'
  export let className = ''
  export let done = false
  export let placeholder = ''
  export let ariaLabel = 'Text'
  export let revision = 0
  export let onChange: (html: string, text: string) => void
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

  let editor: HTMLDivElement
  let renderedHTML = html || escapeHTML(text)
  let lastRevision = revision
  let savedSelection: SavedSelection | null = null
  let restoreSelectionOnNextFocus = false
  let restoreRequest = 0

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

    if (event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.altKey) {
      if (event.shiftKey) {
        event.preventDefault()
        document.execCommand('insertLineBreak')
        persistEditor(activeEditor, false)
        return
      }

      if (onSplit) {
        const split = splitEditorAtSelection(activeEditor)
        if (split) {
          event.preventDefault()
          const source = split.before.html === '' && split.before.text === '' ? split.after : split.before
          activeEditor.innerHTML = source.html
          renderedHTML = source.html
          await onSplit(split.before, split.after, activeEditor)
        }
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
    persistEditor(activeEditor, false)
    saveSelection(activeEditor)
  }

  function handleFocus() {
    if (!restoreSelectionOnNextFocus) return

    scheduleSelectionRestore()
  }

  function handleBlur() {
    if (!editor) return

    saveSelection(editor)
    persistEditor(editor)
  }

  function handleWindowFocus() {
    if (restoreSelectionOnNextFocus) scheduleSelectionRestore()
  }

  function handleWindowBlur() {
    if (editor !== document.activeElement) return

    saveSelection(editor)
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
      document.execCommand('createLink', false, clipboardText.trim())
      persistEditor(activeEditor, false)
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
      document.execCommand('insertHTML', false, pastedHTML)
      persistEditor(activeEditor, false)
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

  function persistEditor(activeEditor: HTMLDivElement, syncRenderedHTML = true) {
    const nextHTML = sanitizeInlineHTML(activeEditor.innerHTML)
    if (syncRenderedHTML && activeEditor.innerHTML !== nextHTML) activeEditor.innerHTML = nextHTML
    if (syncRenderedHTML) renderedHTML = nextHTML
    onChange(nextHTML, htmlToPlainText(nextHTML))
  }

  function hasNonCollapsedSelectionInside(activeEditor: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) return false

    const range = selection.getRangeAt(0)
    return activeEditor.contains(range.commonAncestorContainer)
  }

  function splitEditorAtSelection(activeEditor: HTMLDivElement) {
    const selection = document.getSelection()
    if (!selection || selection.rangeCount === 0) return null

    const range = selection.getRangeAt(0)
    if (!rangeIsInside(activeEditor, range)) return null

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
