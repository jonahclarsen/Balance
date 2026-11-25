// Time pills in notes: the same start/end range as a task's time, inline in
// the text as one character. Keys and drags follow the task time controls:
//
//   Alt+Shift+T          add a fresh pill at the caret / remove the one beside it
//   Alt+[ / ]            start earlier / later
//   Mod+[ / ]            end earlier / later
//   Alt/Mod+Shift+[ / ]  whole range earlier / later
//   drag start / end     move the range / change the end (Alt: start only, Shift: 5 min)
//
// Keys act on the pills in a selection, else the pill nearest the caret in
// its block. Dragging a pill inside a selection with several moves them all.

import {
  $getNearestNodeFromDOMNode,
  $getNodeByKey,
  $getSelection,
  $isNodeSelection,
  type LexicalEditor,
  type NodeKey,
} from 'lexical'
import { beginHapticDrag, endHapticDrag, vibrateSteps } from '../../haptics'
import { installHeldModifiers, modifiersFor, type HeldModifiers } from '../../heldModifiers'
import { freshNoteTime, noteTimeHTML, type NoteTimeRange } from '../../noteTimeMarkup'
import { MAX_TIMELINE_MINUTES } from '../../planner'
import { draggedTimeRange, timeDragDelta, timeDragStepMinutes, type TimeDragEdge } from '../../timeRangeDrag'
import { $inlineLeaves, $nodesFromInlineHTML } from './inline'
import { $isNoteTimeNode, type NoteTimeNode } from './nodes'
import type { NoteEditorMerge } from '../types'
import { $blockOf, $blockPoint, $blocksInOrder, $contentOf, $currentRange, $selectOffset, type BlockPoint } from './structure'

const KEY_STEP_MINUTES = 15
const KEY_MERGE: NoteEditorMerge = { key: 'time-keys', windowMs: 1500 }
let dragSerial = 0
const DRAG_PIXELS_PER_STEP = 10

type Leaf = ReturnType<typeof $inlineLeaves>[number]

function $pillLeaves(point: BlockPoint): Leaf[] {
  return $inlineLeaves($contentOf(point.block)).filter((leaf) => $isNoteTimeNode(leaf.node))
}

function $selectedPills(): NoteTimeNode[] {
  const selection = $getSelection()
  if ($isNodeSelection(selection)) return selection.getNodes().filter($isNoteTimeNode)
  const range = $currentRange()
  if (!range || range.isCollapsed()) return []
  return range.getNodes().filter($isNoteTimeNode)
}

// The pill touching the caret, preferring the one before it.
function $adjacentPill(): NoteTimeNode | null {
  const range = $currentRange()
  const point = range?.isCollapsed() ? $blockPoint(range.focus) : null
  if (!point) return null
  const leaves = $pillLeaves(point)
  const leaf = leaves.find((candidate) => candidate.end === point.offset) ?? leaves.find((candidate) => candidate.start === point.offset)
  return leaf ? leaf.node as NoteTimeNode : null
}

// Pills the time keys act on.
export function $timeKeyTargets(): NoteTimeNode[] {
  const selected = $selectedPills()
  if (selected.length > 0) return selected
  const range = $currentRange()
  const point = range ? $blockPoint(range.focus) : null
  if (!point) return []
  const leaves = $pillLeaves(point)
  const before = leaves.filter((leaf) => leaf.end <= point.offset).at(-1)
  const leaf = before ?? leaves.find((candidate) => candidate.start >= point.offset)
  return leaf ? [leaf.node as NoteTimeNode] : []
}

// The last pill before the caret in document order, so a fresh one follows it.
function $previousPill(point: BlockPoint): NoteTimeRange | null {
  let previous: NoteTimeRange | null = null
  for (const block of $blocksInOrder()) {
    const current = block.is(point.block)
    for (const leaf of $inlineLeaves($contentOf(block))) {
      if (current && leaf.end > point.offset) break
      if ($isNoteTimeNode(leaf.node)) previous = leaf.node.getRange()
    }
    if (current) break
  }
  return previous
}

export function $toggleTimePill(): void {
  const selected = $selectedPills()
  const adjacent = selected.length > 0 ? selected : [$adjacentPill()].filter((node): node is NoteTimeNode => node !== null)
  if (adjacent.length > 0) {
    const first = adjacent[0]
    const block = $blockOf(first)
    const leaf = block ? $inlineLeaves($contentOf(block)).find((candidate) => candidate.node.is(first)) : null
    for (const node of adjacent) node.remove()
    if (block && leaf) $selectOffset(block, leaf.start)
    return
  }

  const range = $currentRange()
  const focus = range ? $blockPoint(range.focus) : null
  if (!range || !focus) return
  // Across blocks, add at the caret's end rather than replacing the rows.
  const anchor = $blockPoint(range.anchor)
  if (anchor && !anchor.block.is(focus.block)) $selectOffset(focus.block, focus.offset)
  const time = freshNoteTime($previousPill(focus))
  const selection = $currentRange()
  selection?.insertNodes($nodesFromInlineHTML(noteTimeHTML(time.startMinutes, time.endMinutes)))
}

export function $shiftTimePills(nodes: NoteTimeNode[], edge: TimeDragEdge | 'both', delta: number): void {
  const ranges = nodes.map((node) => node.getRange())
  const groupDelta = edge === 'both'
    ? Math.max(-Math.min(...ranges.map((range) => range.startMinutes)),
      Math.min(delta, MAX_TIMELINE_MINUTES - Math.max(...ranges.map((range) => range.endMinutes))))
    : delta
  nodes.forEach((node, index) => {
    const { startMinutes, endMinutes } = ranges[index]
    if (edge === 'both') node.setRange(startMinutes + groupDelta, endMinutes + groupDelta)
    else if (edge === 'start') node.setRange(Math.max(0, Math.min(startMinutes + delta, endMinutes - KEY_STEP_MINUTES)), endMinutes)
    else node.setRange(startMinutes, Math.min(MAX_TIMELINE_MINUTES, Math.max(endMinutes + delta, startMinutes + KEY_STEP_MINUTES)))
  })
}

// Handles a time key inside a key-down command; returns whether it did.
export function $handleTimePillKey(event: KeyboardEvent, markEdit: (merge: NoteEditorMerge | null) => void): boolean {
  const mod = event.metaKey || event.ctrlKey
  if (event.altKey && !mod && event.shiftKey && event.code === 'KeyT') {
    event.preventDefault()
    if (!event.repeat) {
      markEdit(null)
      $toggleTimePill()
    }
    return true
  }
  if (event.code !== 'BracketLeft' && event.code !== 'BracketRight') return false
  if (event.altKey === mod) return false
  const edge = event.shiftKey ? 'both' : event.altKey ? 'start' : 'end'
  const targets = $timeKeyTargets()
  if (targets.length === 0) return false
  event.preventDefault()
  markEdit(KEY_MERGE)
  $shiftTimePills(targets, edge, event.code === 'BracketLeft' ? -KEY_STEP_MINUTES : KEY_STEP_MINUTES)
  return true
}

type Drag = {
  part: HTMLElement
  pointerId: number
  edge: TimeDragEdge
  key: NodeKey
  origins: Map<NodeKey, NoteTimeRange>
  originY: number
  clientY: number
  modifiers: HeldModifiers
  lastSteps: number
  merge: NoteEditorMerge
}

// Vertical drags on a pill's start and end, as on a task's time range.
export function noteTimeDrags(root: HTMLElement, editor: LexicalEditor, markEdit: (merge: NoteEditorMerge) => void): () => void {
  installHeldModifiers()
  let drag: Drag | null = null

  const apply = () => {
    if (!drag) return
    const current = drag
    const steps = Math.round((current.originY - current.clientY) / DRAG_PIXELS_PER_STEP)
    if (steps !== current.lastSteps) {
      vibrateSteps(Math.abs(steps - current.lastSteps))
      current.lastSteps = steps
    }
    const stepMinutes = timeDragStepMinutes(current.modifiers.shiftKey)
    const dragged = current.origins.get(current.key)!
    const delta = timeDragDelta(current.edge === 'start' ? dragged.startMinutes : dragged.endMinutes, steps, stepMinutes)
    const startOnly = current.edge === 'start' && current.modifiers.altKey
    const group = current.origins.size > 1 && !startOnly
    const groupDelta = Math.max(-Math.min(...[...current.origins.values()].map((range) => range.startMinutes)),
      Math.min(delta, MAX_TIMELINE_MINUTES - Math.max(...[...current.origins.values()].map((range) => range.endMinutes))))
    editor.update(() => {
      markEdit(current.merge)
      for (const [key, origin] of current.origins) {
        const node = $getNodeByKey(key)
        if (!$isNoteTimeNode(node)) continue
        if (group) node.setRange(origin.startMinutes + groupDelta, origin.endMinutes + groupDelta)
        else if (key === current.key) {
          const next = draggedTimeRange(current.edge, origin.startMinutes, origin.endMinutes, delta, stepMinutes, startOnly)
          node.setRange(next.startMinutes, next.endMinutes)
        } else node.setRange(origin.startMinutes, origin.endMinutes)
      }
    })
  }

  const onKey = (event: KeyboardEvent) => {
    if (!drag) return
    const modifiers = modifiersFor(event)
    if (modifiers.altKey === drag.modifiers.altKey && modifiers.shiftKey === drag.modifiers.shiftKey) return
    drag.modifiers = modifiers
    apply()
  }

  const onMove = (event: PointerEvent) => {
    if (!drag || event.pointerId !== drag.pointerId) return
    drag.clientY = event.clientY
    drag.modifiers = modifiersFor(event)
    apply()
  }

  const end = () => {
    if (!drag) return
    const { part } = drag
    drag = null
    part.removeEventListener('pointermove', onMove)
    part.removeEventListener('pointerup', end)
    part.removeEventListener('pointercancel', end)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('keyup', onKey, true)
    endHapticDrag()
  }

  const onDown = (event: PointerEvent) => {
    if (event.button !== 0 || drag) return
    const part = (event.target as HTMLElement | null)?.closest?.<HTMLElement>('[data-note-time-edge]')
    const pill = part?.closest('time')
    if (!part || !pill || !root.contains(pill)) return
    const found = editor.read(() => {
      const node = $getNearestNodeFromDOMNode(pill)
      if (!$isNoteTimeNode(node)) return null
      const selected = $selectedPills()
      const group = selected.some((candidate) => candidate.is(node)) ? selected : [node]
      return { key: node.getKey(), origins: new Map(group.map((candidate) => [candidate.getKey(), candidate.getRange()])) }
    })
    if (!found) return
    // Keep the caret and selection; the pill is not text to place it in.
    event.preventDefault()
    event.stopPropagation()
    part.setPointerCapture(event.pointerId)
    drag = {
      part,
      pointerId: event.pointerId,
      edge: part.dataset.noteTimeEdge === 'end' ? 'end' : 'start',
      key: found.key,
      origins: found.origins,
      originY: event.clientY,
      clientY: event.clientY,
      modifiers: modifiersFor(event),
      lastSteps: 0,
      // One undo step per drag, however long it pauses.
      merge: { key: `time-drag-${dragSerial += 1}`, windowMs: 10 * 60_000 },
    }
    part.addEventListener('pointermove', onMove)
    part.addEventListener('pointerup', end)
    part.addEventListener('pointercancel', end)
    window.addEventListener('keydown', onKey, true)
    window.addEventListener('keyup', onKey, true)
    beginHapticDrag()
    vibrateSteps()
  }

  // A press on a pill must not start a text selection or drag either.
  const onMouseDown = (event: MouseEvent) => {
    if ((event.target as HTMLElement | null)?.closest?.('[data-note-time-edge]')) event.preventDefault()
  }

  root.addEventListener('pointerdown', onDown, true)
  root.addEventListener('mousedown', onMouseDown, true)
  return () => {
    end()
    root.removeEventListener('pointerdown', onDown, true)
    root.removeEventListener('mousedown', onMouseDown, true)
  }
}
