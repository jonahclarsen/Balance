import { plannerStore } from './store'

/** Start a card move from its content, leaving embedded controls interactive. */
export function projectReordering(node: HTMLElement) {
  let source: HTMLElement | null = null
  let target: HTMLElement | null = null
  let placement: 'before' | 'after' = 'before'
  const indicator = document.createElement('div')
  indicator.className = 'project-drop-indicator'
  indicator.setAttribute('aria-hidden', 'true')
  let pointerId: number | null = null
  let startX = 0
  let startY = 0
  let dragging = false

  function reset() {
    source?.classList.remove('project-dragging')
    indicator.remove()
    if (pointerId !== null && node.hasPointerCapture(pointerId)) node.releasePointerCapture(pointerId)
    source = target = null
    pointerId = null
    dragging = false
  }

  function down(event: PointerEvent) {
    if (!event.isPrimary || event.button !== 0 || pointerId !== null) return
    const element = event.target instanceof Element ? event.target : null
    if (element?.closest('button, input, textarea, select, a, label, [contenteditable], [role="slider"], .probability-slider')) return
    source = element?.closest<HTMLElement>('.project-card') ?? null
    if (!source) return
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    // Avoid text selection competing with the card gesture.
    if (event.pointerType === 'mouse') event.preventDefault()
    node.setPointerCapture(pointerId)
  }

  function move(event: PointerEvent) {
    if (!source || event.pointerId !== pointerId) return
    if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < 6) return
    dragging = true
    source.classList.add('project-dragging')
    updateTarget(event.clientX, event.clientY)
  }

  function updateTarget(x: number, y: number) {
    target = null
    indicator.remove()
    const bounds = node.getBoundingClientRect()
    if (x < bounds.left - 16 || x > bounds.right + 16 || y < bounds.top - 16 || y > bounds.bottom + 16) return
    const cards = [...node.querySelectorAll<HTMLElement>('.project-card')]
    const rects = cards.map((card) => card.getBoundingClientRect())
    const singleColumn = rects.every((rect) => Math.abs(rect.left - rects[0].left) < 1)
    const style = getComputedStyle(node)
    // Convert viewport geometry back to CSS coordinates under the app’s UI zoom.
    const scale = bounds.width / parseFloat(style.width) || 1
    const gap = (parseFloat(style.gap) || 16) * scale
    type Slot = { index: number; card: number; placement: 'before' | 'after'; left: number; top: number; width: number; height: number }
    const slots: Slot[] = []
    rects.forEach((rect, index) => {
      const previous = rects[index - 1]
      const next = rects[index + 1]
      if (singleColumn) {
        slots.push({ index, card: index, placement: 'before', left: rect.left,
          top: previous ? (previous.bottom + rect.top) / 2 : rect.top - gap / 2, width: rect.width, height: 0 })
        if (!next) slots.push({ index: index + 1, card: index, placement: 'after', left: rect.left,
          top: rect.bottom + gap / 2, width: rect.width, height: 0 })
      } else {
        const sameRow = previous && Math.abs(previous.top - rect.top) < 1
        slots.push({ index, card: index, placement: 'before',
          left: sameRow ? (previous.right + rect.left) / 2 : rect.left - gap / 2,
          top: rect.top, width: 0, height: sameRow ? Math.max(previous.height, rect.height) : rect.height })
        // A wrapped row has an insertion point at both its end and the next row's start.
        if (!next || Math.abs(next.top - rect.top) >= 1) {
          slots.push({ index: index + 1, card: index, placement: 'after', left: rect.right + gap / 2,
            top: rect.top, width: 0, height: rect.height })
        }
      }
    })
    const distance = (slot: Slot) => Math.hypot(
      Math.max(slot.left - x, 0, x - slot.left - slot.width),
      Math.max(slot.top - y, 0, y - slot.top - slot.height),
    )
    const slot = slots.reduce<Slot | null>((best, candidate) => !best || distance(candidate) < distance(best) ? candidate : best, null)
    const sourceIndex = cards.indexOf(source!)
    if (!slot || slot.index === sourceIndex || slot.index === sourceIndex + 1) return
    target = cards[slot.card]
    placement = slot.placement
    Object.assign(indicator.style, {
      left: `${(slot.left - bounds.left) / scale - (slot.width === 0 ? 1.5 : 0)}px`,
      top: `${(slot.top - bounds.top) / scale - (slot.height === 0 ? 1.5 : 0)}px`,
      width: `${slot.width / scale || 3}px`, height: `${slot.height / scale || 3}px`,
    })
    node.append(indicator)
  }

  function up(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    if (dragging) updateTarget(event.clientX, event.clientY)
    if (dragging && source && target) {
      plannerStore.moveProject(source.id.slice('project-'.length), target.id.slice('project-'.length), placement)
    }
    reset()
  }

  function cancel(event: PointerEvent) {
    if (event.pointerId === pointerId) reset()
  }

  node.addEventListener('pointerdown', down)
  node.addEventListener('pointermove', move)
  node.addEventListener('pointerup', up)
  node.addEventListener('pointercancel', cancel)
  node.addEventListener('lostpointercapture', cancel)
  return {
    destroy() {
      reset()
      node.removeEventListener('pointerdown', down)
      node.removeEventListener('pointermove', move)
      node.removeEventListener('pointerup', up)
      node.removeEventListener('pointercancel', cancel)
      node.removeEventListener('lostpointercapture', cancel)
    },
  }
}
