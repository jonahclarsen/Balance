// Sizes a textarea to its content so text wraps onto more lines instead of
// scrolling or needing a drag handle. Pass the bound value so updates refit.
export function autoGrow(node: HTMLTextAreaElement, _value?: string) {
  const fit = () => {
    node.style.height = 'auto'
    const style = getComputedStyle(node)
    node.style.height = `${node.scrollHeight + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth)}px`
  }
  const observer = new ResizeObserver(fit)
  observer.observe(node)
  node.addEventListener('input', fit)
  fit()
  return {
    update: fit,
    destroy: () => {
      observer.disconnect()
      node.removeEventListener('input', fit)
    },
  }
}
