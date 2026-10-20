import { expect, test, type Locator, type Page } from '@playwright/test'
import { todayISO } from '../../src/lib/planner'

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
            // A sticky row is constrained by its own subtree. On narrow
            // screens this needs enough children for the long parent to
            // finish clipping before the subtree scrolls out of view.
            ...Array.from({ length: 24 }, (_, index) => ({ id: `grandchild_${index + 2}`, text: `Grandchild ${index + 2}` })),
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
  await page.evaluate(({ tree, date }) => {
    const now = new Date().toISOString()
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
  }, { tree, date: todayISO() })
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
  // The full narrow-screen tree needs hundreds of scroll steps, each waiting
  // for two animation frames. Leave room for that scan on a cold CI runner;
  // individual assertions retain their normal timeout.
  test.setTimeout(60_000)
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
    // Narrow screens wrap this fixture far beyond 1,200px. Traverse the
    // actual scroll range so every nesting level reaches the pinned stack.
    const maximum = target.scrollHeight - target.clientHeight
    const step = Math.max(10, Math.floor(target.clientHeight / 40))
    for (let scrollTop = 0; scrollTop < maximum + step; scrollTop += step) {
      target.scrollTop = Math.min(scrollTop, maximum)
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

test('a clipped parent stays on top and leaves only once its last child reaches what it still shows', async ({ page }) => {
  test.setTimeout(60_000)
  await seed(page, familyTree(words('Long parent', 60)))
  const workspace = page.locator('.workspace')
  await expect(row(workspace, 'Filler 24')).toBeAttached()
  const problems = await row(workspace, words('Long parent', 60)).evaluate(async (parent: HTMLElement) => {
    let scroller: HTMLElement | null = parent.parentElement
    while (scroller && !(/(auto|scroll)/.test(getComputedStyle(scroller).overflowY) && scroller.scrollHeight > scroller.clientHeight)) {
      scroller = scroller.parentElement
    }
    const target = scroller ?? document.scrollingElement as HTMLElement
    const shell = parent.parentElement!
    const problems: string[] = []
    let pinnedTop: number | null = null
    const step = Math.max(8, Math.floor(target.clientHeight / 60))
    for (let scrollTop = 0; scrollTop < target.scrollHeight; scrollTop += step) {
      target.scrollTop = scrollTop
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const rect = parent.getBoundingClientRect()
      const shellRect = shell.getBoundingClientRect()
      if (rect.top <= shellRect.top + 1) continue
      pinnedTop ??= rect.top
      // Once pushed up by the end of its subtree, nothing of the subtree may
      // remain below what the parent still shows.
      const clip = parseFloat(parent.style.getPropertyValue('--tree-sticky-clip')) || 0
      const visibleBottom = rect.bottom - clip * rect.height / parent.offsetHeight
      if (rect.top < pinnedTop - 1 && visibleBottom < shellRect.bottom - 1.5) {
        problems.push(`${scrollTop}: left ${Math.round(shellRect.bottom - visibleBottom)}px early`)
      }
      // Controls of rows scrolling underneath stay under the pinned parent.
      for (const x of [rect.left + 12, (rect.left + rect.right) / 2, rect.right - 20]) {
        const hit = document.elementFromPoint(x, visibleBottom - 3)?.closest('[role="listitem"]')
        if (hit && hit !== parent) problems.push(`${scrollTop}: ${hit.getAttribute('aria-label')?.slice(11, 30)} drawn over the parent`)
      }
    }
    if (pinnedTop === null) problems.push('never pinned')
    return problems.slice(0, 5)
  })
  expect(problems).toEqual([])
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


for (const nestedGrandchild of [false, true]) {
  test(`mixed-height list parents keep whole lines and usable controls (${nestedGrandchild ? 'three' : 'two'} pinned levels)`, async ({ page }, testInfo) => {
    test.setTimeout(60_000)
    const tree = familyTree('Parent')
    tree[0].children![0].text = 'Child line one\nChild line two\nChild line three\nChild line four\nChild line five'
    tree[0].children![0].children![0].text = 'Grandchild line one\nGrandchild line two'
    if (nestedGrandchild) {
      tree[0].children![0].children![0].children = Array.from({ length: 16 }, (_, index) => ({
        id: `great_grandchild_${index}`, text: `Great grandchild ${index + 1}`,
      }))
    }
    await seed(page, tree)
    const dialog = await openOverlay(page)
    const body = dialog.locator('.overlay-body')
    // Let initial keyboard selection finish before exercising manual scrolling.
    await page.waitForTimeout(350)
    const problems = await body.evaluate(async (scroller) => {
      const problems: string[] = []
      const steps = Array.from({ length: 61 }, (_, index) => index * 5)
      for (const top of [...steps, ...steps.reverse()]) {
        scroller.scrollTop = top
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        for (const row of scroller.querySelectorAll<HTMLElement>('.sticky-parent')) {
          const clip = parseFloat(row.style.getPropertyValue('--tree-sticky-clip')) || 0
          if (!clip) continue
          const rect = row.getBoundingClientRect()
          const scale = rect.height / row.offsetHeight
          const visibleBottom = rect.bottom - clip * scale
          const text = row.querySelector<HTMLElement>('.item-text-display')!
          const textClip = parseFloat(text.style.getPropertyValue('--tree-sticky-text-clip')) || 0
          const cutoff = Math.min(visibleBottom, text.getBoundingClientRect().bottom - textClip * scale)
          const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
          const range = document.createRange()
          for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            range.selectNodeContents(node)
            for (const line of range.getClientRects()) {
              if (line.width && line.top < cutoff - 0.5 && line.bottom > cutoff + 0.5) {
                problems.push(`${top}: pinned text cut through a line`)
              }
            }
          }
          for (const control of row.querySelectorAll<HTMLElement>('input[type="checkbox"], .row-actions button')) {
            const box = control.getBoundingClientRect()
            if (box.top < rect.top - 1 || box.bottom > visibleBottom + 1) {
              problems.push(`${top}: pinned control clipped`)
            }
            const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
            if (!control.contains(hit)) problems.push(`${top}: pinned control covered`)
          }
        }
      }
      return problems.slice(0, 10)
    })
    expect(problems).toEqual([])

    // Capture full text, the shrinking edge, and the settled stack.
    for (const top of [0, 65, 100, 220]) {
      await body.evaluate((element, top) => { element.scrollTop = top }, top)
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      await dialog.screenshot({ path: testInfo.outputPath(`mixed-${top}.png`), animations: 'disabled' })
    }
    const child = dialog.locator('[data-plan-item-id="child"]')
    // A real click must reach the compact row without Playwright scrolling it.
    const checkbox = child.getByRole('checkbox')
    const box = (await checkbox.boundingBox())!
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
    await expect(checkbox).toBeChecked()
  })
}


test('a tall parent keeps its goals below the retained text while shrinking on narrow screens', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 412, height: 820 })
  const text = Array.from({ length: 7 }, (_, index) => `Research line ${index + 1}`).join('\n')
  await seed(page, familyTree(text))
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    const timestamp = new Date().toISOString()
    state.goals = ['Health routines', 'Creative practice', 'Personal projects'].map((name, index) => ({
      id: `sticky_goal_${index}`, name, cadenceDays: 1, matchTerms: ['research'], matchTermsHtml: 'research',
      hue: index * 90, lightness: 50,
      activityPeriods: [{ startDate: state.activePlanDate, endDate: null }],
      createdAt: timestamp, updatedAt: timestamp,
    }))
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  const parent = page.locator('[data-plan-item-id="parent"]')
  await expect(parent.locator('.plan-goal-badge')).toHaveCount(3)
  await page.waitForTimeout(350)
  const problems = await parent.evaluate(async (row) => {
    const problems: string[] = []
    const shell = row.parentElement!
    const scroller = document.scrollingElement!
    const start = shell.getBoundingClientRect().top + scroller.scrollTop
    for (const offset of [0, 20, 40, 60, 80, 100, 130, 160, 200, 160, 100, 40, 0]) {
      scroller.scrollTop = start + offset
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const clip = parseFloat(row.style.getPropertyValue('--tree-sticky-clip')) || 0
      if (!clip) continue
      const rect = row.getBoundingClientRect()
      const scale = rect.height / (row as HTMLElement).offsetHeight
      const bottom = rect.bottom - clip * scale
      const text = row.querySelector<HTMLElement>('[data-rich-text-input]')!
      const textClip = parseFloat(text.style.getPropertyValue('--tree-sticky-text-clip')) || 0
      const cutoff = text.getBoundingClientRect().bottom - textClip * scale
      const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT)
      const range = document.createRange()
      const visibleLines: number[] = []
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        range.selectNodeContents(node)
        for (const line of range.getClientRects()) {
          if (line.height && line.bottom <= cutoff + 0.5) visibleLines.push(line.bottom)
        }
      }
      if (!visibleLines.length) problems.push(`${offset}: all text hidden`)
      if (offset === 200 && visibleLines.length !== 3) problems.push(`${offset}: expected three retained lines`)
      for (const badge of row.querySelectorAll<HTMLElement>('.plan-goal-badge')) {
        const box = badge.getBoundingClientRect()
        if (box.top < cutoff - 0.5) problems.push(`${offset}: goal overlaps text`)
        if (box.top < rect.top || box.bottom > bottom + 1) problems.push(`${offset}: goal clipped`)
        const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)
        if (!badge.contains(hit)) problems.push(`${offset}: goal covered`)
      }
    }
    return problems
  })
  await page.screenshot({ path: testInfo.outputPath('sticky-goals.png') })
  expect(problems).toEqual([])
})
