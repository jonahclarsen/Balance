import { expect, test } from '@playwright/test'
import { isURL } from '../../src/lib/planner'

test('isURL accepts web, file and app links', () => {
  for (const url of [
    'https://example.com/path',
    ' http://example.com ',
    'file:///Users/someone/My Doc.pdf',
    'slack://channel?team=T1&id=C1',
    'obsidian://open?vault=Notes&file=Today',
    'things:///show?id=today',
    'x-devonthink-item://ABC-123',
    'ftp://example.com/file',
    'mailto:someone@example.com',
    'tel:+15551234567',
  ]) expect(isURL(url), url).toBe(true)
})

test('isURL rejects plain text, internal links and script schemes', () => {
  for (const value of [
    '',
    'example.com',
    'Note: call back',
    'todo:something',
    'slack://',
    'balance://note/abc',
    'javascript:alert(1)',
    'JavaScript://%0aalert(1)',
    'data:text/html,hi',
    'https://example.com\nopen',
  ]) expect(isURL(value), value).toBe(false)
})
