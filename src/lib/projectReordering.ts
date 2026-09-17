import { plannerStore } from './store'

/** Start a card move from its content, leaving embedded controls interactive. */
export function projectReordering(node: HTMLElement) {
  let source: HTMLElement | null = null
  let target: HTMLElement | null = null
  let pointerId: number | null = null
  let startX = 0
  let startY = 0
  let dragging = false

  function reset() {
    source?.classList.remove('project-dragging')
    target?.classList.remove('project-drop-target')
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
    target?.classList.remove('project-drop-target')
    const hovered = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('.project-card')
    target = hovered && hovered !== source && node.contains(hovered) ? hovered : null
    target?.classList.add('project-drop-target')
  }

  function up(event: PointerEvent) {
    if (event.pointerId !== pointerId) return
    if (dragging && source && target) {
      const cards = [...node.querySelectorAll('.project-card')]
      plannerStore.moveProject(source.id.slice('project-'.length), target.id.slice('project-'.length),
        cards.indexOf(source) < cards.indexOf(target) ? 'after' : 'before')
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
