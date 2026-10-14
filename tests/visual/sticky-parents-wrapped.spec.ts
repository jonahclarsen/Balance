import { expect, test, type Locator, type Page } from '@playwright/test'

// Pinned parents show at most three lines each and five in total, taking lines
// from the deepest rows first while every pinned row keeps one.
const words = (label: string, count: number) => `${label} ${Array.from({ length: count }, (_, index) => `word${index + 1}`).join(' ')}`
const wrappedChild = words('Wrapped child', 90)

type SeedItem = { id: string; text: string; children?: SeedItem[] }

// A parent whose child wraps onto several lines and heads children of its own,
// the first of which wraps too.
function familyTree(parentText: string): SeedItem[] {
  return [
    {
      id: 'parent',
      text: parentText,
      children: [
        {
          id: 'child',
          text: wrappedChild,
          children: [
            { id: 'grandchild_1', text: words('Grandchild 1', 25) },
            ...Array.from({ length: 6 }, (_, index) => ({ id: `grandchild_${index + 2}`, text: `Grandchild ${index + 2}` })),
          ],
        },
        { id: 'sibling', text: 'Sibling' },
      ],
    },
    ...Array.from({ length: 24 }, (_, index) => ({ id: `filler_${index + 1}`, text: `Filler ${index + 1}` })),
  ]
}

// Four nested parents that each wrap onto several lines.
function deepTree(): SeedItem[] {
  const leaves = Array.from({ length: 20 }, (_, index) => ({ id: `leaf_${index + 1}`, text: `Leaf ${index + 1}` }))
  const chain = [4, 3, 2, 1].reduce<SeedItem[]>((children, level) => [
    { id: `level_${level}`, text: words(`Level${level}`, 60), children },
  ], leaves)
  return [...chain, ...Array.from({ length: 24 }, (_, index) => ({ id: `filler_${index + 1}`, text: `Filler ${index + 1}` }))]
}

async function seed(page: Page, tree: SeedItem[]) {
  await page.goto('/')
  await page.evaluate((tree) => {
    // Balance's day starts at 5 a.m.
    const now = new Date(Date.now() - 6 * 60 * 60 * 1000).toISOString()
    const date = now.slice(0, 10)
    type Seed = { id: string; text: string; children?: Seed[] }
    const item = ({ id, text, children = [] }: Seed): object => (
      { id, text, html: text, done: false, startMinutes: null, endMinutes: null, children: children.map(item) }
    )
    localStorage.clear()
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1,
      deviceId: 'sticky-wrapped-test',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: date,
      templates: [],
      plans: [{ id: 'plan', date, title: 'Day', dailyReminder: '', items: [{ id: 'link', text: 'Groceries' }, ...tree].map(item) }],
      listTemplates: [{ id: 'groceries', name: 'Groceries', maxExpectedWords: 0, items: [], archivedItems: [], createdAt: now, updatedAt: now }],
      lists: [{ id: 'groceries_today', date, listTemplateId: 'groceries', createdAt: now, items: tree.map(item) }],
      metrics: [],
      metricEntries: [],
      goals: [],
      goalCompletions: [],
      operations: [],
    }))
  }, tree)
  await page.reload()
}

function row(scope: Locator | Page, text: string) {
  return scope.getByRole('listitem', { name: `Plan item: ${text}`, exact: true })
}

async function openOverlay(page: Page) {
  await page.getByTitle('Open Groceries').first().click()
  const dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(row(dialog, 'Filler 24')).toBeAttached()
  return dialog
}

// Scrolls the rows' scroll container through the whole tree. At every step it
// checks that nothing below the pinned stack is hidden, and it records how
// many text lines each pinned parent shows once it reaches over its children.
async function scanScroll(scope: Locator) {
  return scope.evaluate(async (root) => {
    const firstRow = root.querySelector<HTMLElement>('[role="listitem"]')!
    let scroller: HTMLElement | null = firstRow.parentElement
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) {
      scroller = scroller.parentElement
    }
    const target = scroller ?? document.scrollingElement as HTMLElement
    const rows = [...root.querySelectorAll<HTMLElement>('[role="listitem"]')]
    const name = (element: Element | null | undefined) => element?.getAttribute('aria-label')?.slice(11).split(' ')[0]
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    // The clip is in CSS pixels; browser development zooms the app.
    const visibleBottom = (element: HTMLElement) => {
      const rect = element.getBoundingClientRect()
      const clip = parseFloat(element.style.getPropertyValue('--tree-sticky-clip')) || 0
      return rect.bottom - clip * rect.height / element.offsetHeight
    }
    const lineBottoms = (element: HTMLElement) => {
      const text = element.querySelector<HTMLElement>('[data-rich-text-input], .item-text-display')!
      const range = document.createRange()
      range.selectNodeContents(text.firstChild!)
      const bottoms: number[] = []
      for (const rect of range.getClientRects()) {
        if (!bottoms.length || rect.top >= bottoms[bottoms.length - 1] - 1) bottoms.push(rect.bottom)
      }
      return bottoms
    }
    const problems: string[] = []
    const linesShown: Record<string, number> = {}
    for (let scrollTop = 0; scrollTop <= 1200; scrollTop += 10) {
      target.scrollTop = scrollTop
      await frame()
      const pinned = rows.filter((element) => element.getBoundingClientRect().top > element.parentElement!.getBoundingClientRect().top + 1)
      for (const element of pinned) {
        // Where the first child would sit if it were not pinned itself.
        const firstChildShell = element.parentElement!.querySelector<HTMLElement>(':scope > * [role="listitem"]')!.parentElement!
        const bottom = visibleBottom(element)
        if (bottom <= firstChildShell.getBoundingClientRect().top + 1) continue
        const lines = lineBottoms(element).filter((lineBottom) => lineBottom <= bottom + 1).length
        linesShown[name(element)!] = Math.max(linesShown[name(element)!] ?? 0, lines)
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
        if (hit && hit !== element) problems.push(`${scrollTop}: ${name(element)} covered by ${name(hit)}`)
      }
    }
    return { problems: problems.slice(0, 10), linesShown }
  })
}

test('a one-line parent leaves its wrapped child three pinned lines in the list overlay', async ({ page }) => {
  await seed(page, familyTree('Parent'))
  const result = await scanScroll(await openOverlay(page))
  expect(result.problems).toEqual([])
  expect(result.linesShown).toEqual({ Parent: 1, Wrapped: 3 })
})

test('a one-line parent leaves its wrapped child three pinned lines on Today', async ({ page }) => {
  await seed(page, familyTree('Parent'))
  const workspace = page.locator('.workspace')
  await expect(row(workspace, 'Filler 24')).toBeAttached()
  const result = await scanScroll(workspace)
  expect(result.problems).toEqual([])
  expect(result.linesShown).toEqual({ Parent: 1, Wrapped: 3 })
})

test('a wrapped parent keeps three lines and its wrapped child gets the last two', async ({ page }) => {
  await seed(page, familyTree(words('Long parent', 60)))
  const result = await scanScroll(await openOverlay(page))
  expect(result.problems).toEqual([])
  expect(result.linesShown).toEqual({ Long: 3, Wrapped: 2 })
})

test('deeply nested wrapped parents past the five-line budget keep one line each', async ({ page }) => {
  await seed(page, deepTree())
  const workspace = page.locator('.workspace')
  await expect(row(workspace, 'Filler 24')).toBeAttached()
  const result = await scanScroll(workspace)
  expect(result.problems).toEqual([])
  expect(result.linesShown).toEqual({ Level1: 3, Level2: 2, Level3: 1, Level4: 1 })
})

test('editing a clipped parent shows all of its text', async ({ page }) => {
  await seed(page, familyTree('Parent'))
  const workspace = page.locator('.workspace')
  const child = row(workspace, wrappedChild)
  await row(workspace, 'Grandchild 5').evaluate((element) => element.scrollIntoView({ block: 'center' }))
  await expect.poll(() => child.evaluate((element) => element.style.getPropertyValue('--tree-sticky-clip'))).not.toBe('')
  await expect.poll(() => child.evaluate((element) => getComputedStyle(element).clipPath)).not.toBe('none')

  await child.locator('[data-rich-text-input]').focus()
  await expect.poll(() => child.evaluate((element) => getComputedStyle(element).clipPath)).toBe('none')
})
