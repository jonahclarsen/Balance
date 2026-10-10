// Native storage maintenance gets short foreground idle windows. It never runs
// concurrently with itself, keeps no app content, and backs off after errors.
export function startListStorageMaintenance(
  run: () => Promise<{ more: boolean }>,
  ready: () => boolean,
  environment = {
    now: () => Date.now(),
    visible: () => document.visibilityState === 'visible',
    every: (callback: () => void) => window.setInterval(callback, 5_000),
    clear: (id: number) => window.clearInterval(id),
    activity: (callback: () => void) => {
      const events = ['keydown', 'pointerdown', 'pointermove', 'wheel', 'input']
      events.forEach((event) => window.addEventListener(event, callback, { passive: true }))
      return () => events.forEach((event) => window.removeEventListener(event, callback))
    },
  },
): () => void {
  let stopped = false
  let running = false
  let lastActivity = environment.now()
  let nextRun = lastActivity + 10_000
  const stopActivity = environment.activity(() => { lastActivity = environment.now() })
  const timer = environment.every(() => {
    const now = environment.now()
    if (stopped || running || !ready() || !environment.visible() || now < nextRun || now - lastActivity < 5_000) return
    running = true
    void run().then(({ more }) => {
      nextRun = environment.now() + (more ? 5_000 : 6 * 60 * 60 * 1_000)
    }).catch((error: unknown) => {
      console.error('List storage maintenance failed', error)
      nextRun = environment.now() + 5 * 60 * 1_000
    }).finally(() => { running = false })
  })
  return () => { stopped = true; environment.clear(timer); stopActivity() }
}
