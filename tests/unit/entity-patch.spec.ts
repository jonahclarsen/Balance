import { expect, test } from '@playwright/test'
import { entityPatch } from '../../src/lib/entityPatch'

test('an old editor only addresses changed fields, including nested records by ID', () => {
  const before = { id: 'note', title: 'Before', items: [{ id: 'task', text: 'Before', done: false }] }
  const after = { ...before, items: [{ ...before.items[0], done: true }] }
  expect(entityPatch(before, after)).toEqual({ kind: 'object', fields: {
    items: { kind: 'records', entries: { task: { kind: 'object', fields: { done: { kind: 'replace', value: true } }, remove: [] } }, remove: [] },
  }, remove: [] })
})

test('field deletion, null, record deletion and reordering have distinct meanings', () => {
  expect(entityPatch({ a: 1, b: 2 }, { b: null })).toEqual({ kind: 'object', fields: { b: { kind: 'replace', value: null } }, remove: ['a'] })
  expect(entityPatch([{ id: 'a' }, { id: 'b' }, { id: 'c' }], [{ id: 'c' }, { id: 'a' }])).toEqual({ kind: 'records', entries: {}, remove: ['b'], order: ['c', 'a'] })
})

test('optional properties becoming undefined serialize as explicit removals', () => {
  const patch = entityPatch({ id: 'a', optional: 'old' }, { id: 'a', optional: undefined })
  expect(JSON.parse(JSON.stringify(patch))).toEqual({ kind: 'object', fields: {}, remove: ['optional'] })
  expect(entityPatch({ id: 'a' }, { id: 'a', optional: undefined })).toEqual({ kind: 'object', fields: {}, remove: [] })
})

test('JSON field names do not inherit object prototype properties', () => {
  expect(entityPatch(JSON.parse('{"constructor":"old","__proto__":"old"}'), {})).toEqual({
    kind: 'object', fields: {}, remove: ['constructor', '__proto__'],
  })
})
