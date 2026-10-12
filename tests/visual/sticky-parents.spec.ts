import { expect, test, type Page } from '@playwright/test'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const date = new Date().toISOString().slice(0, 10)
    const item = (id: string, text: string, children: ReturnType<typeof item>[] = []) => (
      { id, text, html: text, done: false, startMinutes: null, endMinutes: null, children }
    )
    const leaves = (prefix: string, count: number) => Array.from(
      { length: count },
      (_, index) => item(`${prefix}_${index + 1}`, `${prefix} step ${index + 1}`),
    )

    localStorage.clear()
    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'sticky-parents-test',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: date,
        templates: [],
        plans: [{
          id: 'plan_sticky',
          date,
          title: 'Sticky day',
          dailyReminder: '',
          items: [
            item('outer', 'Outer project', [
              item('inner', 'Inner phase', leaves('Inner', 24)),
              ...leaves('Outer', 16),
            ]),
            item('second', 'Second project', leaves('Second', 30)),
          ],
        }],
        listTemplates: [],
        lists: [],
        metrics: [],
        metricEntries: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()
  await expect(page.getByRole('listitem', { name: 'Plan item: Second step 30' })).toBeAttached()
})

function row(page: Page, text: string) {
  return page.getByRole('listitem', { name: `Plan item: ${text}`, exact: true })
}

async function revealRow(page: Page, text: string) {
  await row(page, text).evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  }))
}

// Where the pinned stack starts: the workspace's top edge, or below the mobile header.
async function stackTop(page: Page) {
  return page.evaluate(() => {
    const header = document.querySelector('.mobile-app-header')
    if (header && getComputedStyle(header).display !== 'none') return header.getBoundingClientRect().bottom
    return document.querySelector('.workspace')!.getBoundingClientRect().top
  })
}

async function pinState(page: Page, text: string) {
  return row(page, text).evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const shell = element.parentElement!.getBoundingClientRect()
    const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + Math.min(rect.height / 2, 12))
    return {
      pinned: rect.top > shell.top + 1,
      top: rect.top,
      bottom: rect.bottom,
      onTop: hit?.closest('[role="listitem"]') === element,
    }
  })
}

test('parent tasks stay pinned above their children while those children are in view', async ({ page }) => {
  const top = await stackTop(page)

  await revealRow(page, 'Inner step 18')
  const outer = await pinState(page, 'Outer project')
  const inner = await pinState(page, 'Inner phase')
  expect(outer.pinned).toBe(true)
  expect(outer.top).toBeCloseTo(top, 0)
  expect(outer.onTop).toBe(true)
  expect(inner.pinned).toBe(true)
  expect(inner.top).toBeCloseTo(outer.bottom, 0)
  expect(inner.onTop).toBe(true)

  // Past the inner phase's children only the outer project stays pinned.
  await revealRow(page, 'Outer step 12')
  expect((await pinState(page, 'Outer project')).pinned).toBe(true)
  expect((await pinState(page, 'Outer project')).onTop).toBe(true)
  expect((await pinState(page, 'Inner phase')).bottom).toBeLessThanOrEqual((await pinState(page, 'Outer project')).bottom + 1)

  // Leaf rows never pin, and the next parent takes over the top.
  await revealRow(page, 'Second step 20')
  expect((await pinState(page, 'Outer step 16')).pinned).toBe(false)
  const second = await pinState(page, 'Second project')
  expect(second.pinned).toBe(true)
  expect(second.top).toBeCloseTo(top, 0)
  expect(second.onTop).toBe(true)
  expect((await pinState(page, 'Outer project')).bottom).toBeLessThanOrEqual(top + 1)
})

test('a collapsed parent no longer pins', async ({ page }) => {
  await revealRow(page, 'Second step 20')
  expect((await pinState(page, 'Second project')).pinned).toBe(true)
  await expect(row(page, 'Second project')).toHaveClass(/sticky-parent/)
  await row(page, 'Outer project').evaluate((element) => element.scrollIntoView({ block: 'center' }))
  const toggle = row(page, 'Outer project').locator('.children-toggle')
  test.skip(await toggle.count() === 0, 'collapsing is not offered on this surface')
  await toggle.click()
  await expect(row(page, 'Outer project')).not.toHaveClass(/sticky-parent/)
})
