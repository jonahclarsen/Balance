// Runs inside the WebView for both menu eligibility and the selected action.
// Keep selection validation here so a delayed native callback cannot format a
// different field, a collapsed caret, or a selection spanning multiple tasks.
(command => {
  const editor = document.activeElement
  const selection = document.getSelection()
  if (!(editor instanceof HTMLElement) ||
      !editor.matches('[data-rich-text-input][contenteditable="true"]') ||
      !selection || selection.isCollapsed || selection.rangeCount !== 1) return false
  const range = selection.getRangeAt(0)
  if (!editor.contains(range.startContainer) || !editor.contains(range.endContainer)) return false
  if (command !== null) {
    if (!['bold', 'italic', 'underline'].includes(command)) return false
    editor.dispatchEvent(new CustomEvent('balanceformat', { detail: { command } }))
  }
  return true
})
