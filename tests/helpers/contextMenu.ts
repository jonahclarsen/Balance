import type { Locator } from '@playwright/test'

export async function settleContextMenuTarget(target: Locator, position?: { x: number; y: number }) {
  // Right-click focuses cards, which can scroll the note list. Focusing now
  // does not select/open the note.
  if (await target.evaluate(element => element.matches('.note-card'))) await target.focus()
  // Preflight the actual click point. A tall note document may already overlap
  // the viewport while its top-left context-click point is still offscreen.
  await target.click({ button: 'right', position, trial: true })
  await target.evaluate(element => new Promise<void>((resolve, reject) => {
    let previous = ''
    let stableFrames = 0
    let frame = 0
    const reset = () => { stableFrames = 0 }
    const finish = (error?: Error) => {
      cancelAnimationFrame(frame)
      clearTimeout(timeout)
      document.removeEventListener('scroll', reset, true)
      window.removeEventListener('resize', reset)
      if (error) reject(error)
      else resolve()
    }
    const sample = () => {
      if (!element.isConnected) return finish(new Error('Link target detached while settling'))
      const rect = element.getBoundingClientRect()
      const positions = [rect.x, rect.y, rect.width, rect.height]
      for (let ancestor = element.parentElement; ancestor; ancestor = ancestor.parentElement) {
        positions.push(ancestor.scrollLeft, ancestor.scrollTop, ancestor.scrollWidth, ancestor.scrollHeight,
          ancestor.clientWidth, ancestor.clientHeight)
      }
      const current = positions.join(',')
      stableFrames = current === previous ? stableFrames + 1 : 0
      previous = current
      if (stableFrames >= 6) return finish()
      frame = requestAnimationFrame(sample)
    }
    const timeout = setTimeout(() => finish(new Error('Link target scrolling did not settle')), 5000)
    document.addEventListener('scroll', reset, true)
    window.addEventListener('resize', reset)
    frame = requestAnimationFrame(sample)
  }))
}
