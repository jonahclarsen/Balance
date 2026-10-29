import { expect, test } from '@playwright/test'
import { entityPatch, jsonEqual } from '../../src/lib/entityPatch'

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

test('metric answers patch their stable question identity instead of replacing the array', () => {
  expect(entityPatch([{ questionId: 'q', value: '3' }], [{ questionId: 'q', value: '5' }])).toEqual({
    kind: 'records', keyField: 'questionId', entries: { q: { kind: 'object', fields: { value: { kind: 'replace', value: '5' } }, remove: [] } }, remove: [],
  })
})

test('JSON equality matches serialized equality apart from key order', () => {
  const shared = { id: 'a', children: [{ id: 'b', text: 'x' }] }
  expect(jsonEqual({ items: [shared] }, { items: [shared] })).toBe(true)
  expect(jsonEqual({ a: 1, b: [1, { c: 'x' }] }, { b: [1, { c: 'x' }], a: 1 })).toBe(true)
  expect(jsonEqual({ a: 1, gone: undefined }, { a: 1 })).toBe(true)
  expect(jsonEqual({ a: null }, { a: undefined })).toBe(false)
  expect(jsonEqual([undefined], [null])).toBe(true)
  expect(jsonEqual({ a: '1' }, { a: 1 })).toBe(false)
  expect(jsonEqual({ a: [] }, { a: {} })).toBe(false)
  expect(jsonEqual({ a: [1, 2] }, { a: [1, 2, 3] })).toBe(false)
  expect(jsonEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  expect(jsonEqual({ a: { b: { c: 'x' } } }, { a: { b: { c: 'y' } } })).toBe(false)
})
