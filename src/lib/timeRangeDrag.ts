// The drag rules shared by task time ranges and note time pills: dragging the
// start moves the whole range (Alt: only the start), dragging the end changes
// only the end; steps are 15 minutes (Shift: 5).
import { clampMinutes, MAX_TIMELINE_MINUTES } from './planner'

export type TimeDragEdge = 'start' | 'end'

export function timeDragStepMinutes(shiftKey: boolean): number {
  return shiftKey ? 5 : 15
}

// Minutes the dragged edge moves after `steps` steps, snapped to the grid.
export function timeDragDelta(origin: number, steps: number, stepMinutes: number): number {
  return Math.round(origin / stepMinutes + steps) * stepMinutes - origin
}

export function draggedTimeRange(
  edge: TimeDragEdge,
  originStart: number,
  originEnd: number,
  delta: number,
  stepMinutes: number,
  startOnly: boolean,
): { startMinutes: number; endMinutes: number } {
  if (edge === 'start') {
    if (startOnly) {
      const latestStart = Math.floor((originEnd - stepMinutes) / stepMinutes) * stepMinutes
      return { startMinutes: clampMinutes(Math.min(originStart + delta, latestStart)), endMinutes: originEnd }
    }
    const duration = originEnd - originStart
    const latestStart = Math.max(0, Math.floor((MAX_TIMELINE_MINUTES - duration) / stepMinutes) * stepMinutes)
    const startMinutes = clampMinutes(Math.min(originStart + delta, latestStart))
    return { startMinutes, endMinutes: startMinutes + duration }
  }

  const desiredEnd = originEnd + delta
  if (desiredEnd >= originStart + stepMinutes) return { startMinutes: originStart, endMinutes: clampMinutes(desiredEnd) }
  const startMinutes = clampMinutes(desiredEnd - stepMinutes)
  return { startMinutes, endMinutes: startMinutes + stepMinutes }
}
