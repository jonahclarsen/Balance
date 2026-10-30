import { expect, test, type Page } from '@playwright/test'
import { generateDay, openView, showPrimaryNavigation } from '../helpers/navigation'

test.use({ timezoneId: 'America/Vancouver' })


async function addProject(page: Page, name: string) {
  await page.getByRole('textbox', { name: 'New project name' }).fill(name)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
}

async function readState(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let state: any
    plannerStore.subscribe((value: any) => { state = value })()
    return structuredClone({ projects: state.projects, operation: state.operations.at(-1) })
  })
}

test('active projects last whole days from 7 a.m., lead the list and sidebar, and lapse on time', async ({ page }) => {
  // 6 a.m. in Vancouver: the most recent 7 a.m. was yesterday's.
  await page.clock.install({ time: new Date('2026-09-09T13:00:00Z') })
  await page.goto('/')
  await openView(page, 'Projects')
  await addProject(page, 'Synthetic first')
  await addProject(page, 'Synthetic second')
  const names = page.locator('.project-card .project-name')
  await expect(names).toHaveText(['Synthetic first', 'Synthetic second'])

  await page.locator('.project-card', { hasText: 'Synthetic second' }).click()
  const details = page.getByRole('dialog', { name: 'Synthetic second details', exact: true })
  await details.getByRole('button', { name: 'Mark active', exact: true }).click()
  await expect(details.getByRole('group', { name: 'Days active' }).getByRole('button')).toHaveText(['1', '2', '3', '4', '5'])
  await details.getByRole('button', { name: '1 day', exact: true }).click()
  await expect(details).toHaveCount(0)
  const { projects, operation } = await readState(page)
  expect(projects.find((project: any) => project.name === 'Synthetic second').activeUntil).toBe('2026-09-09T14:00:00.000Z')
  expect(operation.type).toBe('apply_entity_changes')
  expect(operation.payload.action).toBe('set_project_active')

  await expect(names).toHaveText(['Synthetic second', 'Synthetic first'])
  await expect(page.locator('.project-card.active')).toHaveText(/Synthetic second\s*until Wed/)
  const preview = page.locator('.sidebar-active-projects button')
  await expect(preview).toHaveText('Synthetic second')

  await openView(page, 'Today')
  await showPrimaryNavigation(page)
  await page.locator('.sidebar-active-projects button').click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
  await expect(details).toBeVisible()
  await details.getByRole('button', { name: 'Close', exact: true }).click()

  // The app clock drops it once 7 a.m. passes.
  await page.clock.fastForward('01:01:00')
  await expect(preview).toHaveCount(0)
  await expect(page.locator('.project-card.active')).toHaveCount(0)
  await expect(names).toHaveText(['Synthetic first', 'Synthetic second'])
})

test('completed and archived projects move to dated sections and support undo, restore and deletion', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-09-08T19:00:00Z'))
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.keyboard.press('Alt+p')
  await addProject(page, 'Synthetic garden')
  await addProject(page, 'Synthetic shed')
  const open = page.locator('section[aria-labelledby="open-projects-title"]')
  const completed = page.locator('section[aria-labelledby="completed-projects-title"]')
  const archived = page.locator('section[aria-labelledby="archived-projects-title"]')

  await page.locator('.project-card', { hasText: 'Synthetic garden' }).click()
  const details = page.getByRole('dialog', { name: 'Synthetic garden details', exact: true })
  await details.getByRole('textbox', { name: 'Description' }).fill('Native plants')
  await details.getByRole('textbox', { name: 'Description' }).blur()
  await details.getByRole('button', { name: 'Mark active', exact: true }).click()
  await details.getByRole('button', { name: '3 days', exact: true }).click()
  await expect(details).toHaveCount(0)
  await expect(page.locator('#active-projects-title')).toHaveText('Active 1')
  await expect(open.locator('.project-card')).toHaveText(['Synthetic shed'])
  await page.locator('.project-card', { hasText: 'Synthetic garden' }).click()
  await details.getByRole('button', { name: 'Complete', exact: true }).click()
  await expect(details).toHaveCount(0)
  await expect(completed.locator('.project-card')).toHaveText(/Synthetic garden:\s*Native plants\s*Sep 8/)
  await expect(open.locator('.project-card')).toHaveText(['Synthetic shed'])
  await expect(page.locator('.sidebar-active-projects')).toHaveCount(0)
  const afterComplete = (await readState(page)).projects.find((project: any) => project.name === 'Synthetic garden')
  expect(afterComplete.activeUntil).toBeUndefined()
  expect(afterComplete.description).toBe('Native plants')

  await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    await plannerStore.undo()
  })
  await expect(completed).toHaveCount(0)
  await expect(page.locator('.project-card.active')).toHaveText(/Synthetic garden/)

  await page.locator('.project-card', { hasText: 'Synthetic garden' }).click()
  await details.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(details).toHaveCount(0)
  await expect(archived.locator('.project-card')).toHaveText(/Synthetic garden:\s*Native plants\s*Sep 8/)
  await page.reload()
  await openView(page, 'Projects')
  await expect(archived.locator('.project-card')).toHaveText(/Synthetic garden/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await archived.locator('.project-card').click()
  await details.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(details).toHaveCount(0)
  await expect(open.locator('.project-card')).toHaveText([/^\s*Synthetic garden:\s*Native plants\s*$/, 'Synthetic shed'])
  await open.locator('.project-card', { hasText: 'Synthetic garden' }).click()
  await details.getByRole('button', { name: 'Mark active', exact: true }).click()
  await expect(details).toBeVisible()
  await details.getByRole('button', { name: '1 day', exact: true }).click()
  await expect(details).toHaveCount(0)
  await page.locator('.project-card', { hasText: 'Synthetic garden' }).click()
  await details.getByRole('button', { name: 'Stop', exact: true }).click()
  await expect(details).toHaveCount(0)
  await open.locator('.project-card', { hasText: 'Synthetic garden' }).click()
  await details.getByRole('button', { name: 'Complete', exact: true }).click()
  await expect(details).toHaveCount(0)
  await completed.locator('.project-card').click()
  await details.getByRole('button', { name: 'Reopen', exact: true }).click()
  await expect(details).toHaveCount(0)
  await open.locator('.project-card', { hasText: 'Synthetic garden' }).click()
  await details.getByRole('button', { name: 'Complete', exact: true }).click()
  await expect(details).toHaveCount(0)
  await completed.locator('.project-card').click()
  await details.getByRole('button', { name: 'Archive', exact: true }).click()
  await expect(details).toHaveCount(0)
  await archived.locator('.project-card').click()
  page.once('dialog', (dialog) => dialog.dismiss())
  await details.getByRole('button', { name: 'Delete forever', exact: true }).click()
  await expect(details).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await details.getByRole('button', { name: 'Delete forever', exact: true }).click()
  await expect(details).toHaveCount(0)
  await expect(archived).toHaveCount(0)
  expect((await readState(page)).projects.map((project: any) => project.name)).toEqual(['Synthetic shed'])
})

test('project history records active stretches and supports adding, editing, deleting and undo', async ({ page }) => {
  // Noon on Tuesday, Sep 8 in Vancouver.
  await page.clock.setFixedTime(new Date('2026-09-08T19:00:00Z'))
  await page.goto('/')
  await openView(page, 'Projects')
  await addProject(page, 'Synthetic garden')
  await addProject(page, 'Synthetic shed')
  await page.locator('.project-card', { hasText: 'Synthetic garden' }).click()
  const details = page.getByRole('dialog', { name: 'Synthetic garden details', exact: true })
  await details.getByRole('button', { name: 'Mark active', exact: true }).click()
  await details.getByRole('button', { name: '2 days', exact: true }).click()

  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'History', exact: true })).toBeVisible()
  const rows = page.locator('.project-history li')
  await expect(rows).toHaveText([/Synthetic garden\s*Sep 8 – Sep 9\s*2d/])

  await page.getByRole('button', { name: 'Add', exact: true }).click()
  const editor = page.getByRole('dialog', { name: 'Add active stretch', exact: true })
  await editor.getByRole('group', { name: 'Project' }).getByRole('button', { name: 'Synthetic shed' }).click()
  await editor.getByLabel('From').fill('2026-08-01')
  await editor.getByLabel('To').fill('2026-08-03')
  await editor.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(editor).toHaveCount(0)
  await expect(rows).toHaveText([/Synthetic garden\s*Sep 8 – Sep 9/, /Synthetic shed\s*Aug 1 – Aug 3\s*3d/])

  await rows.filter({ hasText: 'Synthetic shed' }).getByRole('button').click()
  const edit = page.getByRole('dialog', { name: 'Edit active stretch', exact: true })
  await edit.getByLabel('To').fill('2026-08-04')
  await edit.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(rows.nth(1)).toHaveText(/Aug 1 – Aug 4\s*4d/)

  // Extending the current stretch keeps the project active through its new last day.
  await rows.filter({ hasText: 'Synthetic garden' }).getByRole('button').click()
  await edit.getByLabel('To').fill('2026-09-10')
  await edit.getByRole('button', { name: 'Save', exact: true }).click()
  const garden = (await readState(page)).projects.find((project: any) => project.name === 'Synthetic garden')
  expect(garden.activeUntil).toBe('2026-09-11T14:00:00.000Z')
  expect(garden.activePeriods).toHaveLength(1)
  expect(garden.activePeriods[0].end).toBe(garden.activeUntil)

  await page.reload()
  await openView(page, 'Projects')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(rows).toHaveText([/Sep 8 – Sep 10\s*3d/, /Aug 1 – Aug 4\s*4d/])

  await rows.filter({ hasText: 'Synthetic shed' }).getByRole('button').click()
  await edit.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(rows).toHaveCount(1)
  await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    await plannerStore.undo()
  })
  await expect(rows).toHaveCount(2)

  await page.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(page.locator('.project-card.active')).toHaveText(/Synthetic garden\s*until Fri/)
})

test('retired check-ins complete projects that reached 100% and are then removed', async ({ page }) => {
  await page.goto('/')
  await openView(page, 'Projects')
  await addProject(page, 'Synthetic finished')
  await addProject(page, 'Synthetic reopened')
  // Seed the retired collection, as an older client would have left it.
  await page.evaluate(() => {
    const key = 'balance.appState.v1'
    const state = JSON.parse(localStorage.getItem(key)!)
    const [finished, reopened] = state.projects.map((project: any) => project.id)
    state.projectCheckIns = [
      { id: 'c1', projectId: finished, progress: 100, heart: 50, createdAt: '2026-09-01T10:00:00.000Z' },
      { id: 'c2', projectId: reopened, progress: 100, heart: 50, createdAt: '2026-09-01T10:00:00.000Z' },
      { id: 'c3', projectId: reopened, progress: 60, heart: 50, createdAt: '2026-09-02T10:00:00.000Z' },
    ]
    localStorage.setItem(key, JSON.stringify(state))
  })
  await page.reload()
  await openView(page, 'Projects')
  await expect(page.locator('section[aria-labelledby="completed-projects-title"] .project-card')).toHaveText(/Synthetic finished/)
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!))
  expect(persisted.projectCheckIns).toEqual([])
  expect(persisted.projects.map((project: any) => [project.name, project.completedAt])).toEqual([
    ['Synthetic finished', '2026-09-01T10:00:00.000Z'],
    ['Synthetic reopened', undefined],
  ])
})

for (const destination of ['page', 'project'] as const) {
  test(`pasting a ${destination} link over selected template text preserves the label`, async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await openView(page, 'Projects')
    await addProject(page, 'Synthetic garden')
    const projectId = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).projects[0].id)
    const url = destination === 'page' ? 'balance://projects' : `balance://projects/${projectId}`
    await openView(page, 'Lists')
    await page.getByRole('button', { name: '+ New list', exact: true }).click()
    const editor = page.locator('[data-list-template-text-input]').first()
    await editor.fill('Review my projects today')
    await editor.evaluate((element, link) => {
      element.focus()
      const range = document.createRange()
      range.setStart(element.firstChild!, 7)
      range.setEnd(element.firstChild!, 18)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      const clipboard = new DataTransfer()
      clipboard.setData('text/plain', link)
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
    }, url)
    await editor.blur()
    await expect(editor).toHaveText('Review my projects today')
    await expect(editor.getByRole('link', { name: 'my projects' })).toHaveAttribute('href', url)
    await page.reload()
    await openView(page, 'Lists')
    await expect(editor).toHaveText('Review my projects today')
    const link = editor.getByRole('link', { name: 'my projects' })
    await expect(link).toHaveAttribute('href', url)
    await link.click()
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
    if (destination === 'project') await expect(page.getByRole('dialog', { name: 'Synthetic garden details', exact: true })).toBeVisible()
  })
}

test('project rows reorder by dragging, open on a tap, and retain order through undo and reload', async ({ page }) => {
  await page.goto('/')
  await openView(page, 'Projects')
  for (const name of ['First project', 'Second project', 'Third project']) await addProject(page, name)
  const cards = page.locator('.project-list .project-card')
  const names = cards.locator('.project-name')
  await expect(names).toHaveText(['First project', 'Second project', 'Third project'])
  const first = cards.filter({ hasText: 'First project' })
  const second = cards.filter({ hasText: 'Second project' })
  async function drag(source: ReturnType<Page['locator']>, destination: ReturnType<Page['locator']>, placement: 'before' | 'after' = 'after') {
    await source.scrollIntoViewIfNeeded()
    const start = (await source.boundingBox())!
    const end = (await destination.boundingBox())!
    const x = end.x + end.width / 2
    const y = placement === 'before' ? end.y - 3 : end.y + end.height + 3
    await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
    await page.mouse.down()
    await page.mouse.move(x, y, { steps: 12 })
    const carried = (await source.boundingBox())!
    expect(Math.hypot(carried.x - start.x, carried.y - start.y)).toBeGreaterThan(20)
    const indicator = page.locator('.project-drop-indicator')
    await expect(indicator).toBeVisible()
    await page.mouse.up()
    await expect(indicator).toHaveCount(0)
  }
  await drag(first, second)
  await expect(names).toHaveText(['Second project', 'First project', 'Third project'])
  // A drag never also opens the project.
  await expect(page.getByRole('dialog')).toHaveCount(0)
  const operation = await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let operation: any
    const unsubscribe = plannerStore.subscribe((state: any) => { operation = state.operations.at(-1) })
    unsubscribe()
    await plannerStore.undo()
    return operation
  })
  expect(operation.type).toBe('apply_entity_changes')
  expect(operation.payload.action).toBe('move_project')
  expect(operation.payload.entityChanges.version).toBe(2)
  await expect(names).toHaveText(['First project', 'Second project', 'Third project'])
  await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    await plannerStore.redo()
  })
  await expect(names).toHaveText(['Second project', 'First project', 'Third project'])
  await page.reload()
  await openView(page, 'Projects')
  await expect(names).toHaveText(['Second project', 'First project', 'Third project'])
  await drag(cards.filter({ hasText: 'First project' }), cards.first(), 'before')
  await expect(names).toHaveText(['First project', 'Second project', 'Third project'])
  await expect(page.locator('.project-dragging, .project-drop-indicator')).toHaveCount(0)
  await expect(cards.first()).not.toHaveAttribute('style', /transform/)

  await cards.nth(1).click()
  await expect(page.getByRole('dialog', { name: 'Second project details', exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await cards.first().focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'First project details', exact: true })).toBeVisible()
})

test('dragging a project row to the window edge scrolls the page and keeps the row under the pointer', async ({ page }) => {
  await page.setViewportSize({ width: page.viewportSize()!.width, height: 600 })
  await page.goto('/')
  await openView(page, 'Projects')
  const names = Array.from({ length: 24 }, (_, index) => `Project ${index + 1}`)
  for (const name of names) await addProject(page, name)
  const cards = page.locator('.project-list .project-card')
  await expect(cards.locator('.project-name')).toHaveText(names)
  const source = cards.first()
  await source.scrollIntoViewIfNeeded()
  const scrollTop = () => source.evaluate((card) => {
    for (let element = card.parentElement; element; element = element.parentElement) {
      if (element.scrollTop > 0) return element.scrollTop
    }
    return document.scrollingElement?.scrollTop ?? 0
  })
  const before = await scrollTop()
  const start = (await source.boundingBox())!
  await page.mouse.move(start.x + start.width / 2, start.y + start.height / 2)
  await page.mouse.down()
  const edge = { x: start.x + start.width / 2, y: 596 }
  await page.mouse.move(edge.x, edge.y, { steps: 12 })
  await expect.poll(scrollTop).toBeGreaterThan(before + 200)
  // The carried row follows the pointer while the content scrolls beneath it.
  const carried = (await source.boundingBox())!
  expect(edge.y).toBeGreaterThan(carried.y)
  expect(edge.y).toBeLessThan(carried.y + carried.height)
  // Stop edge scrolling and finish over a visible row.
  await page.mouse.move(edge.x, page.viewportSize()!.height / 2)
  const destination = await cards.evaluateAll((elements) => {
    for (const card of elements.slice(1).reverse()) {
      const rect = card.getBoundingClientRect()
      const y = rect.top + rect.height / 2
      if (y > 56 && y < window.innerHeight - 56) return { x: rect.left + rect.width / 2, y }
    }
    return null
  })
  expect(destination).not.toBeNull()
  await page.mouse.move(destination!.x, destination!.y)
  await expect(page.locator('.project-drop-indicator')).toBeVisible()
  await page.mouse.up()
  await expect(page.locator('.project-dragging, .project-drop-indicator')).toHaveCount(0)
  await expect(cards.locator('.project-name').first()).not.toHaveText('Project 1')
})

test.describe('touch', () => {
  test.use({ hasTouch: true })

  test('project rows scroll under a swipe and move only after a hold, without a link menu', async ({ page }) => {
    await page.setViewportSize({ width: page.viewportSize()!.width, height: 600 })
    await page.goto('/')
    await openView(page, 'Projects')
    const names = Array.from({ length: 16 }, (_, index) => `Project ${index + 1}`)
    for (const name of names) await addProject(page, name)
    const cards = page.locator('.project-list .project-card')
    await expect(cards.locator('.project-name')).toHaveText(names)
    const scrollTop = () => page.evaluate(() => {
      for (let element = document.querySelector('.project-card')?.parentElement; element; element = element.parentElement) {
        if (element.scrollTop > 0) return element.scrollTop
      }
      return document.scrollingElement?.scrollTop ?? 0
    })
    const cdp = await page.context().newCDPSession(page)
    const touch = (type: string, x?: number, y?: number) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: x === undefined ? [] : [{ x, y }] })
    const center = async (index: number) => {
      const box = (await cards.nth(index).boundingBox())!
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }

    // Holding lifts the card; then dragging moves it instead of scrolling.
    await cards.nth(3).evaluate((card) => card.scrollIntoView({ block: 'center' }))
    // Let the scroll settle; a press that stops a fling never lifts a card.
    await page.waitForTimeout(300)
    const from = await center(3)
    const to = await center(5)
    await touch('touchStart', from.x, from.y)
    await expect(page.locator('.project-dragging')).toHaveCount(1)
    const held = await scrollTop()
    for (let step = 1; step <= 12; step += 1) await touch('touchMove', from.x, from.y + (to.y + 10 - from.y) * step / 12)
    await expect(page.locator('.project-drop-indicator')).toBeVisible()
    expect(await scrollTop()).toBe(held)
    // The held press carries the card rather than selecting the text it passes over.
    expect(await page.evaluate(() => document.querySelector('.project-section h3')!.dispatchEvent(new Event('selectstart', { bubbles: true, cancelable: true })))).toBe(false)
    expect(await page.evaluate(() => document.getSelection()?.toString())).toBe('')
    await touch('touchEnd')
    await expect(cards.locator('.project-name').nth(5)).toHaveText('Project 4')
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(page.locator('.link-context-menu')).toHaveCount(0)
    // Let the displaced cards glide into place before tapping one.
    await cards.evaluateAll((elements) => Promise.all(elements.flatMap((card) => card.getAnimations().map((animation) => animation.finished))))

    // A quick tap still opens the project.
    const tap = await center(3)
    await touch('touchStart', tap.x, tap.y)
    await touch('touchEnd')
    await expect(page.getByRole('dialog', { name: 'Project 5 details', exact: true })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(page.getByRole('dialog')).toHaveCount(0)

    // A vertical swipe scrolls straight away and leaves the order alone.
    const swipe = await center(4)
    const before = await scrollTop()
    await touch('touchStart', swipe.x, swipe.y)
    for (let step = 1; step <= 10; step += 1) await touch('touchMove', swipe.x, swipe.y - step * 15)
    await touch('touchEnd')
    await expect.poll(scrollTop).toBeGreaterThan(before + 40)
    await expect(page.locator('.project-dragging')).toHaveCount(0)
    await expect(page.getByRole('dialog')).toHaveCount(0)
    await expect(cards.locator('.project-name').nth(5)).toHaveText('Project 4')

    // A touch long press never opens the link menu; a right-click still does.
    // Scrolling closes the menu, so wait for the swipe's fling to stop first.
    await expect.poll(async () => { const top = await scrollTop(); await page.waitForTimeout(150); return top === await scrollTop() }).toBe(true)
    await cards.nth(3).evaluate((card) => card.dispatchEvent(new PointerEvent('contextmenu', { pointerType: 'touch', bubbles: true, cancelable: true })))
    await expect(page.locator('.link-context-menu')).toHaveCount(0)
    await cards.nth(3).click({ button: 'right' })
    await expect(page.locator('.link-context-menu')).toBeVisible()
  })
})

async function pasteLinkOverText(editor: import('@playwright/test').Locator, link: string, start: number, end: number) {
  await editor.evaluate((element, selection) => {
    const range = document.createRange()
    range.setStart(element.firstChild!, selection.start)
    range.setEnd(element.firstChild!, selection.end)
    const browserSelection = document.getSelection()
    browserSelection?.removeAllRanges()
    browserSelection?.addRange(range)
    const clipboard = new DataTransfer()
    clipboard.setData('text/plain', selection.link)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
  }, { link, start, end })
}

test('pasting a link over selected project name text links it when creating and editing', async ({ page }) => {
  await page.goto('/')
  await openView(page, 'Projects')
  const newName = page.getByRole('textbox', { name: 'New project name' })
  await newName.fill('Synthetic garden plan')
  await pasteLinkOverText(newName, 'obsidian://open?vault=Garden', 10, 16)
  await newName.press('Enter')

  const heading = page.locator('.project-card .project-name')
  await expect(heading).toHaveText('Synthetic garden plan')
  await expect(heading.getByRole('link', { name: 'garden' })).toHaveAttribute('href', 'obsidian://open?vault=Garden')
  await expect(newName).toHaveText('')

  await page.locator('.project-card .project-dot').click()
  const editName = page.getByRole('textbox', { name: 'Project name', exact: true })
  await pasteLinkOverText(editName, 'https://example.com/plan', 0, 9)
  await expect(heading.getByRole('link', { name: 'Synthetic' })).toHaveAttribute('href', 'https://example.com/plan')
  await page.reload()
  await openView(page, 'Projects')
  await expect(heading.getByRole('link', { name: 'garden' })).toHaveAttribute('href', 'obsidian://open?vault=Garden')
  await expect(heading.getByRole('link', { name: 'Synthetic' })).toHaveAttribute('href', 'https://example.com/plan')
})

test('rapid adding keeps the cursor in place, and the name field opens at its end and closes on Enter', async ({ page }) => {
  await page.goto('/')
  await openView(page, 'Projects')
  const newName = page.getByRole('textbox', { name: 'New project name' })
  await newName.fill('Synthetic one')
  await newName.press('Enter')
  await expect(newName).toBeFocused()
  await newName.pressSequentially('Synthetic two')
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await expect(newName).toBeFocused()
  await expect(newName).toHaveText('')
  await expect(page.locator('.project-card.highlighted')).toHaveText('Synthetic two')
  await expect(page.locator('#open-projects-title')).toHaveText('Open 2')

  await page.locator('.project-card', { hasText: 'Synthetic one' }).click()
  const details = page.getByRole('dialog', { name: /^Synthetic one.* details$/ })
  const editName = details.getByRole('textbox', { name: 'Project name', exact: true })
  await expect(editName).toBeFocused()
  await page.keyboard.type(' plan ')
  await details.getByRole('textbox', { name: 'Description' }).fill('Synthetic notes\n\nMore')
  await details.getByRole('textbox', { name: 'Description' }).blur()
  await editName.focus()
  await editName.press('Enter')
  await expect(details).toHaveCount(0)
  await expect(page.locator('.project-card .project-name')).toHaveText(['Synthetic one plan:', 'Synthetic two'])
  await expect(page.locator('.project-card .project-description')).toHaveText(['Synthetic notes…'])
  const { projects } = await readState(page)
  expect(projects.find((project: any) => project.name.startsWith('Synthetic one')).name).toBe('Synthetic one plan')
})

test('long project descriptions truncate within the page and remain editable in full', async ({ page }) => {
  await page.goto('/')
  await openView(page, 'Projects')
  await addProject(page, 'Synthetic long description')
  const card = page.locator('.project-card', { hasText: 'Synthetic long description' })
  await card.click()
  const description = 'A very long first line with words '.repeat(100)
  const details = page.getByRole('dialog')
  await details.getByRole('textbox', { name: 'Description' }).fill(description)
  await details.getByRole('textbox', { name: 'Description' }).press('Escape')
  const preview = card.locator('.project-description')
  await expect(preview).toHaveText(description.trim())
  expect(await preview.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true)
  await expect(preview).toHaveCSS('text-overflow', 'ellipsis')
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  const cardBounds = await card.boundingBox()
  const panelBounds = await page.locator('.projects-panel').boundingBox()
  expect(cardBounds!.x + cardBounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width + 1)
  await card.click()
  const field = details.getByRole('textbox', { name: 'Description' })
  await expect(field).toHaveText(description)
  // The description fills the card up to its max height instead of the card scrolling.
  const fit = await details.evaluate(card => {
    const body = card.querySelector<HTMLElement>('.project-details')!
    const editor = card.querySelector<HTMLElement>('.description-editor')!
    return {
      bodyScrolls: body.scrollHeight > body.clientHeight,
      editorScrolls: editor.scrollHeight > editor.clientHeight,
      cardFull: card.getBoundingClientRect().height >= Math.min(innerHeight * 0.82, card.parentElement!.clientHeight - 48) - 2,
    }
  })
  expect(fit).toEqual({ bodyScrolls: false, editorScrolls: true, cardFull: true })
  await field.fill('Synthetic\nshort\nnotes\nthat\nfit')
  expect(await field.evaluate(editor => editor.scrollHeight <= editor.clientHeight)).toBe(true)
})

test('project descriptions turn pasted URLs into links like tasks do, and their links open', async ({ page }) => {
  await page.goto('/')
  await openView(page, 'Projects')
  await addProject(page, 'Synthetic source')
  await addProject(page, 'Synthetic target')
  const target = (await readState(page)).projects.find((project: any) => project.name === 'Synthetic target')
  await page.locator('.project-card', { hasText: 'Synthetic source' }).click()
  const details = page.getByRole('dialog', { name: 'Synthetic source details', exact: true })
  const description = details.getByRole('textbox', { name: 'Description' })
  await description.fill('See docs then target')
  const paste = (text: string, selected: string) => description.evaluate((editor, { text, selected }) => {
    editor.focus()
    const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT)
    let node = walker.nextNode()
    while (node && !node.textContent!.includes(selected)) node = walker.nextNode()
    const start = node!.textContent!.indexOf(selected)
    const range = document.createRange()
    range.setStart(node!, start)
    range.setEnd(node!, start + selected.length)
    document.getSelection()!.removeAllRanges()
    document.getSelection()!.addRange(range)
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  }, { text, selected })

  // Pasting a URL over selected text links that text.
  await paste('https://example.com/docs', 'docs')
  await expect(description.locator('a[href="https://example.com/docs"]')).toHaveText('docs')
  await paste(`balance://projects/${target.id}`, 'target')
  await expect(description.locator(`a[href="balance://projects/${target.id}"]`)).toHaveText('target')
  const saved = (await readState(page)).projects.find((project: any) => project.name === 'Synthetic source')
  expect(saved.description).toBe('See docs then target')
  expect(saved.descriptionHtml).toContain('href="https://example.com/docs"')

  // Clicking an internal link opens its destination.
  await description.locator('a', { hasText: 'target' }).click()
  await expect(page.getByRole('dialog', { name: 'Synthetic target details', exact: true })).toBeVisible()
})

test('undo in an unsaved project field undoes typing, and undoing an add leaves no unavailable notice', async ({ page }) => {
  await page.goto('/')
  await openView(page, 'Projects')
  const newName = page.getByRole('textbox', { name: 'New project name' })
  const names = page.locator('.project-card .project-name')
  await addProject(page, 'Synthetic kept')

  await newName.click()
  await newName.pressSequentially('Draft')
  await newName.press('ControlOrMeta+z')
  await expect(newName).not.toHaveText('Draft')
  await expect(names).toHaveText(['Synthetic kept'])
  await newName.press('ControlOrMeta+Shift+z')
  await expect(newName).toHaveText('Draft')

  // Adding records history, so undo right after Enter removes the project.
  await newName.press('Enter')
  await expect(names).toHaveText(['Synthetic kept', 'Draft'])
  await newName.press('ControlOrMeta+z')
  await expect(names).toHaveText(['Synthetic kept'])
  await expect(page.getByText('Project unavailable.')).toHaveCount(0)

  // Typing in the description is one undo step that leaves other projects alone.
  await page.locator('.project-card', { hasText: 'Synthetic kept' }).click()
  const description = page.getByRole('dialog').getByRole('textbox', { name: 'Description' })
  await description.click()
  await description.pressSequentially('Notes')
  await description.press('ControlOrMeta+z')
  await expect(description).not.toHaveText('Notes')
  await expect(names).toHaveText(['Synthetic kept'])

  // Closing with Escape keeps what was typed, line breaks included.
  await description.pressSequentially('One')
  await description.press('Shift+Enter')
  await description.press('Enter')
  await description.pressSequentially('Two')
  await description.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.locator('.project-card', { hasText: 'Synthetic kept' }).click()
  await expect.poll(() => description.evaluate(editor => editor.innerText.trimEnd())).toBe('One\n\nTwo')
  expect((await readState(page)).projects.find((project: any) => project.name === 'Synthetic kept').description).toBe('One\n\nTwo')
})

test('generating a day with no project active by noon settles ended projects and picks new ones', async ({ page }) => {
  // 9 p.m. in Vancouver on the 9th, generating the 10th.
  await page.clock.install({ time: new Date('2026-09-10T04:00:00Z') })
  await page.goto('/')
  await openView(page, 'Projects')
  for (const name of ['Synthetic ended', 'Synthetic kept', 'Synthetic next']) await addProject(page, name)
  await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let state: any
    plannerStore.subscribe((value: any) => { state = value })()
    // Both end at 7 a.m. on the 10th, before noon on the generated day.
    for (const project of state.projects.filter((project: any) => project.name !== 'Synthetic next')) plannerStore.setProjectActiveDays(project.id, 1)
    plannerStore.setActivePlanDate('2026-09-10')
  })

  await generateDay(page)
  const pick = page.getByRole('dialog', { name: 'Pick projects', exact: true })
  await expect(pick.locator('.pick')).toHaveText(['Synthetic endedended', 'Synthetic keptended', 'Synthetic next'])
  const days = pick.getByRole('group', { name: 'Days active' }).getByRole('button')
  await expect(days.first()).toBeDisabled()

  // Closing skips generating the day.
  await pick.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(pick).toBeHidden()
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).plans.length)).toBe(0)

  await generateDay(page)
  await pick.locator('li', { hasText: 'Synthetic ended' }).getByRole('button', { name: 'Complete', exact: true }).click()
  await pick.getByRole('button', { name: /^Synthetic next/ }).click()
  await pick.getByRole('textbox', { name: 'New project name' }).fill('Synthetic new')
  await pick.getByRole('button', { name: 'Add', exact: true }).click()
  await pick.getByRole('button', { name: '2 days', exact: true }).click()
  await expect(pick).toBeHidden()

  const { projects } = await readState(page)
  const byName = Object.fromEntries(projects.map((project: any) => [project.name, project]))
  expect(byName['Synthetic ended'].completedAt).toBeTruthy()
  expect(byName['Synthetic ended'].activeUntil).toBeUndefined()
  expect(byName['Synthetic kept'].completedAt).toBeUndefined()
  expect(byName['Synthetic kept'].activeUntil).toBeUndefined()
  // Two days from 7 a.m. on the generated day.
  expect(byName['Synthetic next'].activeUntil).toBe('2026-09-12T14:00:00.000Z')
  expect(byName['Synthetic new'].activeUntil).toBe('2026-09-12T14:00:00.000Z')
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()

  // With a project active by noon, generating again asks nothing.
  await generateDay(page)
  await expect(pick).toBeHidden()
})
