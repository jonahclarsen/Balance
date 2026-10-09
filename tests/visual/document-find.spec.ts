import { expect, test, type Page } from '@playwright/test'
import { openView } from '../helpers/navigation'

async function seedTemplates(page: Page) {
  await page.goto('/')
  await page.evaluate(() => {
    localStorage.clear()
    const now = new Date().toISOString()
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1, deviceId: 'test-device', localSequence: 0, historyRevision: 0,
      activePlanDate: '2026-09-11', goals: [], goalCompletions: [], operations: [],
      templates: [
        { id: 'alpha', name: 'Alpha', texts: ['Needle first', 'Needle second', 'Unrelated task'] },
        { id: 'beta', name: 'Beta', texts: ['Needle third'] },
        { id: 'gamma', name: 'Gamma', texts: ['Nothing here'] },
      ].map(({ id, name, texts }) => ({
        id, name, createdAt: now, updatedAt: now,
        items: texts.map((text, index) => ({
          id: `${id}-${index}`, startMinutes: null, endMinutes: null, children: [],
          options: [{ id: `${id}-${index}-option`, text, html: text, probability: 100 }],
        })),
      })),
      plans: [], lists: [], listTemplates: [], notes: [],
    }))
  })
  await page.reload()
  await openView(page, 'Days')
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Alpha')
  await page.keyboard.press('Meta+f')
  await page.getByLabel('Find text', { exact: true }).fill('needle')
  await expect(page.locator('.find-status')).toHaveText('1/2 matches')
}

async function expectHighlight(page: Page, itemId: string | null) {
  await expect.poll(() => page.evaluate(() => {
    const highlight = CSS.highlights.get('balance-document-find-match')
    if (!highlight) return null
    return Array.from(highlight, (range) => {
      if (!(range instanceof Range)) return null
      return {
        text: range.toString().toLowerCase(),
        itemId: range.startContainer.parentElement?.closest('[data-template-item-id]')?.getAttribute('data-template-item-id'),
      }
    })
  })).toEqual(itemId ? [{ text: 'needle', itemId }] : null)
}

test('document find refreshes across matching and nonmatching day templates', async ({ page }) => {
  await seedTemplates(page)
  await page.getByLabel('Find text', { exact: true }).press('Enter')
  await expectHighlight(page, 'alpha-1')

  for (const [name, status, itemId] of [
    ['Beta', '1/1 matches', 'beta-0'],
    ['Gamma', 'No matches', null],
    ['Alpha', '1/2 matches', 'alpha-0'],
  ] as const) {
    const tab = page.getByRole('button', { name, exact: true })
    await tab.click()
    await expect(page.locator('.find-status')).toHaveText(status)
    await expectHighlight(page, itemId)
    await expect(page.getByLabel('Find text', { exact: true })).not.toBeFocused()
    await expect(page.getByLabel('Find text', { exact: true })).toHaveValue('needle')
  }
  await page.getByLabel('Find text', { exact: true }).press('Shift+Enter')
  await expectHighlight(page, 'alpha-1')
})

test('document find drops deleted matches and finds restored tasks', async ({ page }) => {
  await seedTemplates(page)
  const first = page.locator('[data-template-option-text-input]').filter({ hasText: 'Needle first' })
  await first.click()
  await page.keyboard.press('Meta+Backspace')
  await expect(first).toHaveCount(0)
  await expect(page.locator('.find-status')).toHaveText('1/1 matches')
  await expectHighlight(page, 'alpha-1')

  const second = page.locator('[data-template-option-text-input]').filter({ hasText: 'Needle second' })
  await second.click()
  await page.keyboard.press('Meta+Backspace')
  await expect(second).toHaveCount(0)
  await expect(page.locator('.find-status')).toHaveText('No matches')
  await expectHighlight(page, null)
  await page.keyboard.press('Meta+z')
  await expect(second).toBeVisible()
  // Undo reveals its destination and closes find; reopening must start fresh.
  await page.keyboard.press('Meta+f')
  await page.getByLabel('Find text', { exact: true }).fill('needle')
  await expect(page.locator('.find-status')).toHaveText('1/1 matches')
  await expectHighlight(page, 'alpha-1')
})

test('document find refreshes edited text without stealing editor focus', async ({ page }) => {
  await seedTemplates(page)
  const editor = page.locator('[data-template-option-text-input]').filter({ hasText: 'Needle first' })
  const editable = page.locator('[data-template-option-text-input-id="alpha-0-option"]')
  await editor.fill('Changed task')
  await expect(page.locator('.find-status')).toHaveText('1/1 matches')
  await expectHighlight(page, 'alpha-1')
  await expect(editable).toBeFocused()
  await editable.fill('Needle replaced')
  await expect(page.locator('.find-status')).toHaveText('2/2 matches')
  await expectHighlight(page, 'alpha-1')
  await expect(editable).toBeFocused()
  await page.getByLabel('Find text', { exact: true }).press('Enter')
  await expectHighlight(page, 'alpha-0')
})

test('document find survives rapid keyboard template switches followed by deletion', async ({ page }) => {
  await seedTemplates(page)
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.keyboard.press('Alt+w')
    await page.keyboard.press('Alt+w')
    await page.keyboard.press('Alt+w')
  }
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Alpha')
  // A template switch refreshes find after layout. Wait for that refresh before
  // pressing Enter, otherwise it can reset the newly selected second match.
  await expect(page.locator('.find-status')).toHaveText('1/2 matches')
  await expectHighlight(page, 'alpha-0')
  const input = page.getByLabel('Find text', { exact: true })
  await input.press('Enter')
  await expectHighlight(page, 'alpha-1')
  await page.locator('[data-template-option-text-input-id="alpha-1-option"]').click()
  await page.keyboard.press('Meta+Backspace')
  await expect(page.locator('.find-status')).toHaveText('1/1 matches')
  await expectHighlight(page, 'alpha-0')
  await input.press('Shift+Enter')
  await expectHighlight(page, 'alpha-0')
  await input.fill('missing phrase')
  await expect(page.locator('.find-status')).toHaveText('No matches')
  await input.fill('')
  await expect(page.locator('.find-status')).toBeEmpty()
  await expectHighlight(page, null)
  await page.keyboard.press('Escape')
  await expect(page.locator('.document-find')).toHaveCount(0)
})

async function highlightedText(page: Page, name = 'balance-document-find-match') {
  return page.evaluate((name) => Array.from(CSS.highlights.get(name) ?? [], (range) => range.toString()), name)
}

test('find matches formatted phrases, line breaks and Unicode with accurate ranges', async ({ page }) => {
  await seedTemplates(page)
  await page.locator('.workspace').evaluate((root) => {
    const fixture = document.createElement('div')
    fixture.innerHTML = '<p>İ prefix 🪡 <strong>Orchid</strong> bloom</p><p>Orchid<br>bloom</p><p>Orchid&nbsp;   bloom</p><p>Orchid</p><p>bloom</p>'
    root.append(fixture)
  })
  const input = page.getByLabel('Find text', { exact: true })
  await input.fill('orchid bloom')
  await expect(page.locator('.find-status')).toHaveText('1/3 matches')
  expect(await highlightedText(page)).toEqual(['Orchid bloom'])
  expect(await highlightedText(page, 'balance-document-find-all')).toHaveLength(3)
  await input.press('Shift+Enter')
  await expect(page.locator('.find-status')).toHaveText('3/3 matches')
  await input.fill('orchidbloom')
  await expect(page.locator('.find-status')).toHaveText('No matches')
  await input.fill('prefix 🪡')
  await expect(page.locator('.find-status')).toHaveText('1/1 matches')
  expect(await highlightedText(page)).toEqual(['prefix 🪡'])
})

test('find excludes navigation and hidden text and refreshes when visibility changes', async ({ page }) => {
  await seedTemplates(page)
  await page.evaluate(() => {
    const outside = document.createElement('p')
    outside.textContent = 'Orchid outside'
    document.body.append(outside)
    const fixture = document.createElement('div')
    fixture.innerHTML = '<p>Orchid visible</p><p hidden>Orchid hidden</p><p aria-hidden="true">Orchid aria</p><p style="visibility:hidden">Orchid invisible</p><p data-find-hidden style="display:none">Orchid toggled</p>'
    document.querySelector('.workspace')!.append(fixture)
  })
  await page.getByLabel('Find text', { exact: true }).fill('orchid')
  await expect(page.locator('.find-status')).toHaveText('1/1 matches')
  await page.locator('[data-find-hidden]').evaluate((element) => (element as HTMLElement).style.display = 'block')
  await expect(page.locator('.find-status')).toHaveText('1/2 matches')
  await page.addStyleTag({ content: '.find-test-hidden { display: none !important }' })
  await page.locator('[data-find-hidden]').evaluate((element) => element.classList.add('find-test-hidden'))
  await expect(page.locator('.find-status')).toHaveText('1/1 matches')
})

test('find restores editor caret, selects the query on reopen and cleans up highlights', async ({ page }) => {
  await seedTemplates(page)
  await page.keyboard.press('Escape')
  const editor = page.locator('[data-template-option-text-input-id="alpha-0-option"]')
  await editor.focus()
  await page.keyboard.press('Home')
  await page.keyboard.press('ArrowRight')
  const caret = await page.evaluate(() => window.getSelection()?.anchorOffset)
  await page.keyboard.press('Control+f')
  const input = page.getByLabel('Find text', { exact: true })
  await input.fill('needle')
  await expect(page.locator('.find-status')).toHaveText('1/2 matches')
  await page.keyboard.press('Control+f')
  expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual([0, 6])
  await page.getByRole('button', { name: 'Close find', exact: true }).click()
  await expect(editor).toBeFocused()
  expect(await page.evaluate(() => window.getSelection()?.anchorOffset)).toBe(caret)
  expect(await highlightedText(page)).toEqual([])
  expect(await highlightedText(page, 'balance-document-find-all')).toEqual([])
})

test('find navigation reuses matches, supports standard shortcuts and leaves IME Enter alone', async ({ page }) => {
  await seedTemplates(page)
  const input = page.getByLabel('Find text', { exact: true })
  await input.dispatchEvent('compositionstart')
  await input.dispatchEvent('keydown', { key: 'Enter', isComposing: true })
  await expectHighlight(page, 'alpha-0')
  await input.dispatchEvent('compositionend')
  await expect(page.locator('.find-status')).toHaveText('1/2 matches')
  // Let composition's debounced search settle before measuring navigation.
  await expect.poll(() => highlightedText(page)).toEqual(['Needle'])
  await page.evaluate(() => {
    const original = document.createRange.bind(document)
    ;(window as unknown as { findRangeBuilds: number }).findRangeBuilds = 0
    document.createRange = () => {
      ;(window as unknown as { findRangeBuilds: number }).findRangeBuilds += 1
      return original()
    }
  })
  for (const [shortcut, itemId] of [
    ['Control+g', 'alpha-1'], ['F3', 'alpha-0'],
    ['Shift+F3', 'alpha-1'], ['Control+Shift+g', 'alpha-0'],
  ] as const) {
    await page.keyboard.press(shortcut)
    await expectHighlight(page, itemId)
  }
  await expectHighlight(page, 'alpha-0')
  expect(await page.evaluate(() => (window as unknown as { findRangeBuilds: number }).findRangeBuilds)).toBe(0)
  await input.fill('missing')
  // Enter before the debounce fires selects the first match, without skipping it.
  await input.evaluate((element: HTMLInputElement) => {
    element.value = 'needle'
    element.dispatchEvent(new Event('input', { bubbles: true }))
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await expectHighlight(page, 'alpha-0')
  await input.fill('   ')
  await expect(page.locator('.find-status')).toBeEmpty()
  await expect(page.getByRole('button', { name: 'Next match', exact: true })).toBeDisabled()
})

test('find reveals the matching text inside a long zoomed scroll container', async ({ page }) => {
  await seedTemplates(page)
  await page.locator('.workspace').evaluate((root) => {
    const scroller = document.createElement('div')
    scroller.dataset.findScroller = ''
    scroller.style.cssText = 'height:140px;overflow:auto;zoom:1.25'
    const paragraph = document.createElement('p')
    paragraph.append(document.createTextNode('Start of a long editor'))
    const spacer = document.createElement('span')
    spacer.style.cssText = 'display:block;height:1200px'
    paragraph.append(spacer)
    const target = document.createElement('span')
    target.textContent = 'Orchid destination'
    target.dataset.findTarget = ''
    paragraph.append(target)
    scroller.append(paragraph)
    root.append(scroller)
  })
  await page.getByLabel('Find text', { exact: true }).fill('orchid destination')
  await expect(page.locator('.find-status')).toHaveText('1/1 matches')
  await expect.poll(() => page.locator('[data-find-scroller]').evaluate((element) => {
    const target = element.querySelector('[data-find-target]')!.getBoundingClientRect()
    const viewport = element.getBoundingClientRect()
    // CSS zoom can round the maximum scroll offset by a fraction of a pixel.
    return target.top >= viewport.top - 1 && target.bottom <= viewport.bottom + 1 && element.scrollTop > 0
  })).toBe(true)
  await expect(page.getByLabel('Find text', { exact: true })).toBeFocused()
})

test('navigation immediately after removing the active match does not skip its successor', async ({ page }) => {
  await seedTemplates(page)
  await page.locator('.workspace').evaluate((root) => {
    const fixture = document.createElement('div')
    fixture.innerHTML = '<p data-find-remove>Orchid first</p><p>Orchid second</p><p>Orchid third</p>'
    root.append(fixture)
  })
  const input = page.getByLabel('Find text', { exact: true })
  await input.fill('orchid')
  await expect(page.locator('.find-status')).toHaveText('1/3 matches')
  await input.evaluate((element) => {
    document.querySelector('[data-find-remove]')!.remove()
    // Same turn: MutationObserver has not delivered the removal yet.
    element.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  await expect(page.locator('.find-status')).toHaveText('1/2 matches')
  await expect.poll(() => page.evaluate(() => {
    const range = Array.from(CSS.highlights.get('balance-document-find-match') ?? [])[0]
    return range instanceof Range ? range.startContainer.textContent : null
  })).toBe('Orchid second')
})
