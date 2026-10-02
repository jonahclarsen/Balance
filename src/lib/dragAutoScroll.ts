const AUTO_SCROLL_EDGE = 56
const AUTO_SCROLL_MAX_SPEED = 810 // Pixels per second, independent of refresh rate.
const AUTO_SCROLL_CURVE = 2
const AUTO_SCROLL_RAMP = 0.08 // Seconds to reach ~63% of target velocity.

/**
 * Scroll the drag source's nearest scroll container while the pointer rests
 * near its top or bottom edge, easing in and speeding up toward the edge.
 */
export function dragAutoScroll(onScroll: () => void) {
  let pointer: { x: number; y: number } | null = null
  let container: HTMLElement | null = null
  let frame: number | null = null
  let time: number | null = null
  let velocity = 0

  function schedule() {
    if (frame !== null) return
    time ??= performance.now()
    frame = requestAnimationFrame(step)
  }

  function step(now: number) {
    frame = null
    if (!pointer || !container) return
    const bounds = scrollBounds(container)
    const targetSpeed = autoScrollTargetSpeed(pointer.y, bounds.top, bounds.bottom)
    if (targetSpeed === 0) {
      velocity = 0
      time = null
      return
    }
    // Clamp long frames so resuming a backgrounded window cannot jump the list.
    const elapsed = Math.max(0, Math.min((now - (time ?? now)) / 1000, 0.05))
    time = now
    if (Math.sign(velocity) !== Math.sign(targetSpeed)) velocity = 0
    velocity += (targetSpeed - velocity) * (1 - Math.exp(-elapsed / AUTO_SCROLL_RAMP))
    const previousScrollTop = container.scrollTop
    container.scrollBy({ top: velocity * elapsed, left: 0, behavior: 'instant' })
    if (container.scrollTop !== previousScrollTop) onScroll()
    schedule()
  }

  return {
    start(source: HTMLElement, x: number, y: number) {
      container = nearestScrollContainer(source)
      pointer = { x, y }
    },
    move(x: number, y: number) {
      if (!container) return
      pointer = { x, y }
      schedule()
    },
    stop() {
      time = null
      velocity = 0
      pointer = null
      container = null
      if (frame === null) return
      cancelAnimationFrame(frame)
      frame = null
    },
  }
}

function autoScrollTargetSpeed(clientY: number, top: number, bottom: number) {
  const edge = Math.min(AUTO_SCROLL_EDGE, (bottom - top) / 2)
  if (edge <= 0) return 0
  if (clientY < top + edge) {
    return -AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, clientY - top) / edge) ** AUTO_SCROLL_CURVE
  }
  if (clientY > bottom - edge) {
    return AUTO_SCROLL_MAX_SPEED * (1 - Math.max(0, bottom - clientY) / edge) ** AUTO_SCROLL_CURVE
  }
  return 0
}

function nearestScrollContainer(start: HTMLElement) {
  let candidate = start.parentElement
  while (candidate && candidate !== document.body && candidate !== document.documentElement) {
    const overflowY = getComputedStyle(candidate).overflowY
    if (/(auto|scroll|overlay)/.test(overflowY) && candidate.scrollHeight > candidate.clientHeight) return candidate
    candidate = candidate.parentElement
  }
  // Root overflow can be propagated from body to the viewport. In that case
  // body reports `overflow-y: auto`, but changing body.scrollTop does nothing;
  // scroll the browser's actual root scroller instead.
  return document.scrollingElement as HTMLElement | null
}

function scrollBounds(scrollContainer: HTMLElement) {
  if (scrollContainer === document.scrollingElement) {
    return { top: 0, bottom: window.visualViewport?.height ?? window.innerHeight }
  }
  const rect = scrollContainer.getBoundingClientRect()
  return {
    top: Math.max(0, rect.top),
    bottom: Math.min(window.visualViewport?.height ?? window.innerHeight, rect.bottom),
  }
}
