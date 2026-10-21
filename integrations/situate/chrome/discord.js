/** The parent channel of the Discord thread shown in the sidebar, read from element IDs only. */
// Loaded before content.js, which shares this content-script scope.
function situateDiscordParent(document, threadId) {
  if (!/^\d+$/.test(threadId ?? '')) return ''
  const item = document.querySelector(`[data-list-item-id="channels___${threadId}"]`)
  const group = item?.closest('[role="group"]')
  if (!group) return ''
  // Threads are grouped under their channel, either inside its list item or right after it.
  const hosts = [group.closest('li'), group.previousElementSibling].filter(Boolean)
  for (const host of hosts) {
    const ids = [...host.querySelectorAll('[data-list-item-id^="channels___"]'), ...(host.matches('[data-list-item-id^="channels___"]') ? [host] : [])]
      .map(e => e.getAttribute('data-list-item-id').slice('channels___'.length))
      .filter(id => /^\d+$/.test(id) && id !== threadId && !group.contains(document.querySelector(`[data-list-item-id="channels___${id}"]`)))
    if (ids.length) return ids[0]
  }
  return ''
}
