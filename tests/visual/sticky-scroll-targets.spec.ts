import { expect, test, type Page } from '@playwright/test'
import { todayISO } from '../../src/lib/planner'

// Rows the app scrolls to on its own must land below the parents that pin
// above them, not behind them.
type SeedItem = { id: string; text: string; children?: SeedItem[] }
const words = (label: string, count: number) => `${label} ${Array.from({ length: count }, (_, index) => `word${index + 1}`).join(' ')}`
const leaves = (prefix: string, count: number) => Array.from({ length: count }, (_, index) => ({ id: `${prefix}_${index + 1}`, text: `${prefix} ${index + 1}` }))
const tree: SeedItem[] = [
  ...leaves('Before', 6),
  {
    id: 'outer', text: words('Outer', 30), children: [
      ...leaves('Outer child', 2),
      { id: 'middle', text: words('Middle', 30), children: [...leaves('Middle child', 2), { id: 'inner', text: words('Inner', 30), children: leaves('Deep', 4) }] },
      ...leaves('Outer tail', 3),
    ],
  },
  ...leaves('After', 20),
]

async function seed(page: Page) {
  await page.goto('/')
  await page.evaluate(({ tree, date }) => {
    const now = new Date().toISOString()
    type Seed = { id: string; text: string; children?: Seed[] }
    const item = ({ id, text, children = [] }: Seed): object => (
      { id, text, html: text, done: false, startMinutes: null, endMinutes: null, children: children.map(item) }
    )
    const templateItem = ({ id, text, children = [] }: Seed): object => (
      { id: `template_${id}`, text, html: text, probability: 1, children: children.map(templateItem) }
    )
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1, deviceId: 'sticky-scroll-test', localSequence: 0, historyRevision: 0, activePlanDate: date, templates: [],
      plans: [{ id: 'plan', date, title: 'Day', dailyReminder: '', items: [item({ id: 'link', text: 'Errands' })] }],
      listTemplates: [{ id: 'errands', name: 'Errands', maxExpectedWords: 0, items: tree.map(templateItem), archivedItems: [], createdAt: now, updatedAt: now }],
      lists: [{ id: 'errands_today', date, listTemplateId: 'errands', createdAt: now, items: tree.map(item) }],
      metrics: [], metricEntries: [], goals: [], goalCompletions: [], operations: [],
    }))
  }, { tree, date: todayISO() })
  await page.reload()
}

// How far the row's top sits behind the visible bottom of its pinned parents.
async function hiddenBehindParents(page: Page, selector: string) {
  return page.locator(selector).evaluate((row) => {
    let hidden = 0
    for (let shell = row.parentElement?.parentElement?.closest('.item-shell, .template-item'); shell; shell = shell.parentElement?.closest('.item-shell, .template-item')) {
      const parent = shell.firstElementChild as HTMLElement | null
      if (!parent?.classList.contains('sticky-parent')) continue
      const rect = parent.getBoundingClientRect()
      const clip = parseFloat(parent.style.getPropertyValue('--tree-sticky-clip')) || 0
      hidden = Math.max(hidden, rect.bottom - clip * rect.height / parent.offsetHeight - row.getBoundingClientRect().top)
    }
    return Math.round(hidden)
  })
}

async function openOverlay(page: Page) {
  await page.getByTitle('Open Errands').first().click()
  const dialog = page.getByRole('dialog', { name: 'Errands' })
  await expect(dialog.locator('[data-plan-item-id="After_20"]')).toBeAttached()
  await page.waitForTimeout(350)
  return dialog
}

test('selecting rows in the list overlay lands them below their pinned parents', async ({ page }) => {
  test.setTimeout(60_000)
  await seed(page)
  const dialog = await openOverlay(page)
  for (const id of ['Outer child_2', 'Middle child_1', 'Deep_1', 'Deep_3', 'Outer tail_1']) {
    const selector = `[role="dialog"] [data-plan-item-id="${id}"]`
    await dialog.locator(`[data-plan-item-id="${id}"] .item-text-display`).click()
    await expect.poll(() => hiddenBehindParents(page, selector), { message: id }).toBeLessThanOrEqual(0)
  }
})

test('editing a nested list row from the overlay reveals it below its pinned parents', async ({ page }) => {
  await seed(page)
  const dialog = await openOverlay(page)
  const row = dialog.locator('[data-plan-item-id="Deep_2"]')
  await row.locator('.item-text-display').click()
  await row.getByRole('button', { name: /edit/i }).first().click()
  const selector = '[data-list-template-item-id="template_Deep_2"]'
  await expect(page.locator(`${selector} [data-rich-text-input]`)).toBeFocused()
  await expect.poll(() => hiddenBehindParents(page, selector)).toBeLessThanOrEqual(0)
})
