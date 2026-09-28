// Mobile-layout conformance (Pixel 7 projects): P-54 layout, P-55 toolbar
// docking, P-56 caret visibility, and basic editing on a touch viewport.

import { expect, flatten, test } from './harness'

test('P-54 the note body flows in the page without horizontal overflow and edits persist', async ({ harness }) => {
  await harness.boot({ select: 'Nested lists' })
  const note = harness.noteByTitle('Nested lists')
  const overflow = await harness.page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)
  expect(overflow).toBeLessThanOrEqual(1)
  const target = flatten(note.items).find((item) => item.text === 'Sourdough')!
  await harness.block(target.id).scrollIntoViewIfNeeded()
  await harness.placeCaret(target.id, target.text.length)
  await harness.page.keyboard.type(' loaf')
  await harness.waitForNote(note.id, (stored) => flatten(stored.items).find((item) => item.id === target.id)!.text === 'Sourdough loaf')
})

test('P-55 the formatting toolbar docks above an open keyboard while editing and taps keep focus', async ({ harness }) => {
  await harness.boot({ select: 'Simple paragraphs' })
  const note = harness.noteByTitle('Simple paragraphs')
  await harness.placeCaret(note.items[0].id, 3)
  // Simulate the on-screen keyboard: shrink the visual viewport reported to the page.
  await harness.page.evaluate(() => {
    const viewport = window.visualViewport!
    Object.defineProperty(viewport, 'height', { configurable: true, get: () => window.innerHeight - 320 })
    Object.defineProperty(viewport, 'offsetTop', { configurable: true, get: () => 0 })
    viewport.dispatchEvent(new Event('resize'))
    window.dispatchEvent(new Event('resize'))
  })
  const toolbar = harness.page.getByRole('toolbar', { name: 'Note formatting' })
  await expect.poll(() => toolbar.evaluate((element) => getComputedStyle(element).position)).toBe('fixed')
  const box = (await toolbar.boundingBox())!
  const viewportHeight = harness.page.viewportSize()!.height
  expect(box.y + box.height).toBeLessThanOrEqual(viewportHeight - 320 + 2)
  await toolbar.getByRole('button', { name: 'Bold' }).dispatchEvent('pointerdown')
  expect(await harness.page.evaluate(() => document.activeElement?.closest('[data-rich-text-input]') !== null)).toBe(true)
})

test('checklists toggle by tap and the slash menu fits the small viewport', async ({ harness }) => {
  await harness.boot({ select: 'Checklist' })
  const note = harness.noteByTitle('Checklist')
  await harness.page.locator(`[data-note-item-id="${note.items[1].id}"]`).first().getByRole('checkbox').first().tap()
  await harness.waitForNote(note.id, (stored) => stored.items[1].done)
  const last = note.items[note.items.length - 1]
  await harness.placeCaret(last.id, last.text.length)
  await harness.page.keyboard.press('Enter')
  await harness.page.keyboard.type('/')
  const menu = harness.page.getByRole('listbox', { name: 'Note styles' })
  await expect(menu).toBeVisible()
  const box = (await menu.boundingBox())!
  const size = harness.page.viewportSize()!
  expect(box.x).toBeGreaterThanOrEqual(0)
  expect(box.x + box.width).toBeLessThanOrEqual(size.width)
  expect(box.y + box.height).toBeLessThanOrEqual(size.height)
})
