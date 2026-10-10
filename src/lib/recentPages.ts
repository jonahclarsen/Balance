import { writable } from 'svelte/store'

// Cache component DOM only. Planner data continues to come from the live store.
export function createRecentPages() {
  const RETENTION_MS = 30_000
  const MAX_PAGES = 3
  const store = writable<string[]>([])
  let pages: string[] = []
  let active: string | null = null
  const inactiveSince = new Map<string, number>()
  let timer: ReturnType<typeof setTimeout> | undefined

  function prune() {
    clearTimeout(timer)
    const now = Date.now()
    pages = pages.filter((id) => id === active || now - (inactiveSince.get(id) ?? 0) < RETENTION_MS)
    while (pages.length > MAX_PAGES) pages.shift()
    for (const id of inactiveSince.keys()) if (!pages.includes(id)) inactiveSince.delete(id)
    store.set(pages)
    const deadlines = [...inactiveSince.values()].map((since) => since + RETENTION_MS - now)
    if (deadlines.length) timer = setTimeout(prune, Math.min(...deadlines))
  }

  return {
    subscribe: store.subscribe,
    visit(id: string) {
      if (id === active) return
      if (active) inactiveSince.set(active, Date.now())
      active = id
      inactiveSince.delete(id)
      pages = [...pages.filter((entry) => entry !== id), id]
      prune()
    },
    destroy() { clearTimeout(timer) },
  }
}
