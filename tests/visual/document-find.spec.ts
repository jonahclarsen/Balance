import { expect, test, type Page } from '@playwright/test'

async function seedTemplates(page: Page, isMobile: boolean) {
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
  if (isMobile) await page.getByRole('button', { name: 'Open navigation', exact: true }).click()
  await page.getByRole('button', { name: 'Day Templates', exact: true }).click()
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
  if (!itemId) await expect(page.locator('.find-match-overlay')).toHaveCount(0)
}

test('document find refreshes across matching and nonmatching day templates', async ({ page, isMobile }) => {
  await seedTemplates(page, isMobile)
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

test('document find drops deleted matches and finds restored tasks', async ({ page, isMobile }) => {
  await seedTemplates(page, isMobile)
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

test('document find refreshes edited text without stealing editor focus', async ({ page, isMobile }) => {
  await seedTemplates(page, isMobile)
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

test('document find survives rapid keyboard template switches followed by deletion', async ({ page, isMobile }) => {
  await seedTemplates(page, isMobile)
  for (let cycle = 0; cycle < 3; cycle += 1) {
    await page.keyboard.press('Alt+w')
    await page.keyboard.press('Alt+w')
    await page.keyboard.press('Alt+w')
  }
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue('Alpha')
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
