/** Move an overlay outside the scrolling workspace, matching the list modal's placement. */
export function mountInContentShell(node: HTMLElement) {
  node.closest('.content-shell')?.appendChild(node)
  return { destroy: () => node.remove() }
}
