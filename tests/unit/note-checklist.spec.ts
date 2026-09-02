import { expect, test } from '@playwright/test'
import { patchNoteChecklistItemsDone, reconcileNoteChecklistItems } from '../../src/lib/planner'
import type { NoteItem, NoteItemKind } from '../../src/lib/types'

function item(
  id: string,
  kind: NoteItemKind = 'checklist',
  done = false,
  children: NoteItem[] = [],
): NoteItem {
  return {
    id,
    kind,
    text: id,
    html: id,
    done,
    startMinutes: null,
    endMinutes: null,
    children,
  }
}

function doneState(items: NoteItem[]) {
  return Object.fromEntries(items.flatMap((entry) => [
    [entry.id, entry.done],
    ...Object.entries(doneState(entry.children)),
  ]))
}

test('checking or unchecking a checklist item cascades through every checklist descendant', () => {
  const items = [
    item('parent', 'checklist', false, [
      item('child', 'checklist', false, [item('grandchild')]),
      item('direct-child'),
    ]),
    item('unrelated'),
  ]

  const checked = patchNoteChecklistItemsDone(items, ['parent'], true)
  expect(doneState(checked)).toEqual({
    parent: true,
    child: true,
    grandchild: true,
    'direct-child': true,
    unrelated: false,
  })

  const unchecked = patchNoteChecklistItemsDone(checked, ['child'], false)
  expect(doneState(unchecked)).toEqual({
    parent: false,
    child: false,
    grandchild: false,
    'direct-child': true,
    unrelated: false,
  })
})

test('checking the final incomplete child checks every satisfied checklist ancestor', () => {
  const items = [
    item('parent', 'checklist', false, [
      item('child-group', 'checklist', false, [item('first', 'checklist', true), item('final')]),
      item('direct-child', 'checklist', true),
    ]),
  ]

  const checked = patchNoteChecklistItemsDone(items, ['final'], true)
  expect(doneState(checked)).toEqual({
    parent: true,
    'child-group': true,
    first: true,
    final: true,
    'direct-child': true,
  })
})

test('non-checklist list items can wrap checklist descendants without breaking parent state', () => {
  const items = [
    item('parent', 'checklist', true, [
      item('bullet-wrapper', 'bullet', false, [item('nested-check', 'checklist', false)]),
    ]),
  ]

  expect(doneState(reconcileNoteChecklistItems(items))).toEqual({
    parent: false,
    'bullet-wrapper': false,
    'nested-check': false,
  })

  expect(doneState(patchNoteChecklistItemsDone(items, ['parent'], true))).toEqual({
    parent: true,
    'bullet-wrapper': false,
    'nested-check': true,
  })
})
