import { expect, test, type Page } from '@playwright/test'
import { openView, showPrimaryNavigation } from '../helpers/navigation'

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
  await expect(details.getByText(/^Active until/)).toBeVisible()
  const { projects, operation } = await readState(page)
  expect(projects.find((project: any) => project.name === 'Synthetic second').activeUntil).toBe('2026-09-09T14:00:00.000Z')
  expect(operation.type).toBe('apply_entity_changes')
  expect(operation.payload.action).toBe('set_project_active')
  await details.getByRole('button', { name: 'Close', exact: true }).click()

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
  await details.getByRole('button', { name: 'Complete', exact: true }).click()
  await expect(details.getByText('Completed Sep 8')).toBeVisible()
  await details.getByRole('button', { name: 'Close', exact: true }).click()
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
  await expect(details.getByText('Archived Sep 8')).toBeVisible()
  await details.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(archived.locator('.project-card')).toHaveText(/Synthetic garden:\s*Native plants\s*Sep 8/)
  await page.reload()
  await openView(page, 'Projects')
  await expect(archived.locator('.project-card')).toHaveText(/Synthetic garden/)
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)

  await archived.locator('.project-card').click()
  await details.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(open.locator('.project-card')).toHaveText([/^\s*Synthetic garden:\s*Native plants\s*$/, 'Synthetic shed'])
  await details.getByRole('button', { name: 'Archive', exact: true }).click()
  page.once('dialog', (dialog) => dialog.dismiss())
  await details.getByRole('button', { name: 'Delete forever', exact: true }).click()
  await expect(details).toBeVisible()
  page.once('dialog', (dialog) => dialog.accept())
  await details.getByRole('button', { name: 'Delete forever', exact: true }).click()
  await expect(details).toHaveCount(0)
  await expect(archived).toHaveCount(0)
  expect((await readState(page)).projects.map((project: any) => project.name)).toEqual(['Synthetic shed'])
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
  await expect(description).not.toHaveValue('Notes')
  await expect(names).toHaveText(['Synthetic kept'])

  // Closing with Escape keeps what was typed, line breaks included.
  await description.pressSequentially('One')
  await description.press('Shift+Enter')
  await description.press('Enter')
  await description.pressSequentially('Two')
  await description.press('Escape')
  await expect(page.getByRole('dialog')).toHaveCount(0)
  await page.locator('.project-card', { hasText: 'Synthetic kept' }).click()
  await expect(description).toHaveValue('One\n\nTwo')
})
