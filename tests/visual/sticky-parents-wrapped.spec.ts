import { expect, test, type Locator, type Page } from '@playwright/test'

// The shape that hid rows: a one-line parent whose child wraps onto several
// lines and heads children of its own, the first of which wraps too.
const words = (label: string, count: number) => `${label} ${Array.from({ length: count }, (_, index) => `word${index + 1}`).join(' ')}`
const wrappedChild = words('Wrapped child', 90)

async function seed(page: Page) {
  await page.goto('/')
  await page.evaluate(({ wrappedChild, grandchild }) => {
    // Balance's day starts at 5 a.m.
    const now = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const date = now.slice(0, 10)
    const item = (id: string, text: string, children: ReturnType<typeof item>[] = []) => (
      { id, text, html: text, done: false, startMinutes: null, endMinutes: null, children }
    )
    const tree = () => [
      item('parent', 'Parent', [
        item('child', wrappedChild, [
          item('grandchild_1', grandchild),
          ...Array.from({ length: 6 }, (_, index) => item(`grandchild_${index + 2}`, `Grandchild ${index + 2}`)),
        ]),
        item('sibling', 'Sibling'),
      ]),
      ...Array.from({ length: 24 }, (_, index) => item(`filler_${index + 1}`, `Filler ${index + 1}`)),
    ]
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1,
      deviceId: 'sticky-wrapped-test',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: date,
      templates: [],
      plans: [{ id: 'plan', date, title: 'Day', dailyReminder: '', items: [item('link', 'Groceries'), ...tree()] }],
      listTemplates: [{ id: 'groceries', name: 'Groceries', maxExpectedWords: 0, items: [], archivedItems: [], createdAt: now, updatedAt: now }],
      lists: [{ id: 'groceries_today', date, listTemplateId: 'groceries', createdAt: now, items: tree() }],
      metrics: [],
      metricEntries: [],
      goals: [],
      goalCompletions: [],
      operations: [],
    }))
  }, { wrappedChild, grandchild: words('Grandchild 1', 25) })
  await page.reload()
}

function row(scope: Locator | Page, text: string) {
  return scope.getByRole('listitem', { name: `Plan item: ${text}`, exact: true })
}

// Scrolls the rows' scroll container through the whole tree and, at every
// step, checks that no pinned parent overlaps its own children and that
// nothing below the pinned stack is hidden.
async function scanScroll(scope: Locator) {
  return scope.evaluate(async (root) => {
    const firstRow = root.querySelector<HTMLElement>('[role="listitem"]')!
    let scroller: HTMLElement | null = firstRow.parentElement
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) {
      scroller = scroller.parentElement
    }
    const target = scroller ?? document.scrollingElement as HTMLElement
    const rows = [...root.querySelectorAll<HTMLElement>('[role="listitem"]')]
    const label = (element: Element | null | undefined) => element?.getAttribute('aria-label')?.slice(11, 30)
    const oneLine = rows.find((element) => label(element) === 'Parent')!.getBoundingClientRect().height
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    // The clip is in CSS pixels; browser development zooms the app.
    const visibleBottom = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      const clip = parseFloat(element.style.getPropertyValue('--tree-sticky-clip')) || 0
      return rect.bottom - clip * rect.height / element.offsetHeight
    }
    const problems: string[] = []
    let minWrappedChildShown = Infinity
    for (let scrollTop = 0; scrollTop <= 700; scrollTop += 10) {
      target.scrollTop = scrollTop
      await frame()
      const pinned = rows.filter((element) => element.getBoundingClientRect().top > element.parentElement!.getBoundingClientRect().top + 1)
      for (const element of pinned) {
        const top = element.getBoundingClientRect().top
        const firstChild = element.parentElement!.querySelector<HTMLElement>(':scope > * [role="listitem"]')!
        const shown = visibleBottom(element) - top
        // A pinned row may cover its children only down to its first line.
        if (shown > Math.max(oneLine, firstChild.getBoundingClientRect().top - top) + 1) {
          problems.push(`${scrollTop}: ${label(element)} shows ${Math.round(shown)}px over its children`)
        }
        if (label(element)?.startsWith('Wrapped child')) minWrappedChildShown = Math.min(minWrappedChildShown, shown)
      }
      const stackBottom = Math.max(scroller?.getBoundingClientRect().top ?? 0, ...pinned.map(visibleBottom))
      const viewportBottom = scroller?.getBoundingClientRect().bottom ?? window.innerHeight
      for (const element of rows) {
        if (pinned.includes(element)) continue
        const rect = element.getBoundingClientRect()
        const probeY = Math.max(rect.top, stackBottom) + 3
        if (probeY > rect.bottom - 3 || probeY > viewportBottom - 3) continue
        const hit = document.elementFromPoint(rect.left + rect.width / 2, probeY)?.closest('[role="listitem"]')
        // Rows only answer for each other; headers above the list may cover them.
        if (hit && hit !== element) problems.push(`${scrollTop}: ${label(element)} covered by ${label(hit)}`)
      }
    }
    return { problems: problems.slice(0, 10), minWrappedChildShown, oneLine }
  })
}

test('a wrapped parent pins one line in the list overlay and never covers its children', async ({ page }) => {
  await seed(page)
  await page.getByTitle('Open Groceries').first().click()
  const dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(row(dialog, 'Filler 24')).toBeAttached()

  const result = await scanScroll(dialog)
  expect(result.problems).toEqual([])
  expect(result.minWrappedChildShown).toBeLessThanOrEqual(result.oneLine + 1)
})

test('a wrapped parent pins one line on Today and never covers its children', async ({ page }) => {
  await seed(page)
  const workspace = page.locator('.workspace')
  await expect(row(workspace, 'Filler 24')).toBeAttached()

  const result = await scanScroll(workspace)
  expect(result.problems).toEqual([])
  expect(result.minWrappedChildShown).toBeLessThanOrEqual(result.oneLine + 1)
})

test('editing a clipped parent shows all of its text', async ({ page }) => {
  await seed(page)
  const workspace = page.locator('.workspace')
  const child = row(workspace, wrappedChild)
  await row(workspace, 'Grandchild 5').evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expect.poll(() => child.evaluate((element) => element.style.getPropertyValue('--tree-sticky-clip'))).not.toBe('')
  await expect.poll(() => child.evaluate((element) => getComputedStyle(element).clipPath)).not.toBe('none')

  await child.locator('[data-rich-text-input]').focus()
  await expect.poll(() => child.evaluate((element) => getComputedStyle(element).clipPath)).toBe('none')
})
