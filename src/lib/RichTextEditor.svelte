<script lang="ts">
  import { escapeHTML, htmlToPlainText, isURL, sanitizeInlineHTML } from './planner'
  import type { Id, MoveDirection } from './types'

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

  let editor: HTMLDivElement
  let renderedHTML = html || escapeHTML(text)
  let lastRevision = revision

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
      if (editor) editor.innerHTML = nextHTML
    }
  }

  async function handleKeydown(event: KeyboardEvent) {
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

    if (!onArrowKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return
    if (event.metaKey || event.ctrlKey) return

    event.preventDefault()
    await onArrowKey(event.key === 'ArrowUp' ? 'up' : 'down', event.currentTarget as HTMLDivElement, event)
  }

  function handleInput(event: Event) {
    persistEditor(event.currentTarget as HTMLDivElement, false)
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
      const pastedHTML = clipboardHTML
        ? sanitizeInlineHTML(clipboardHTML)
        : escapeHTML(clipboardText).replace(/\r?\n/g, '<br>')
      document.execCommand('insertHTML', false, pastedHTML)
      persistEditor(activeEditor, false)
    }
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
  on:blur={() => {
    if (editor) persistEditor(editor)
  }}
  on:keydown={handleKeydown}
  on:input={handleInput}
  on:paste={handlePaste}
>{@html renderedHTML}</div>
