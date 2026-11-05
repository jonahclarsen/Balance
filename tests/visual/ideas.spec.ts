import { expect, test, type Page } from '@playwright/test'
import { generateDay, openView } from '../helpers/navigation'

test.use({ timezoneId: 'America/Vancouver' })

// 11 a.m. in Vancouver, well clear of the 5 a.m. day boundary.
const NOW = new Date('2026-10-08T18:00:00Z')

async function storeCall(page: Page, script: string) {
  return page.evaluate(async (body) => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    return new Function('plannerStore', body)(plannerStore)
  }, script)
}

async function groups(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let value: any
    plannerStore.subscribe((state: any) => { value = state })()
    return Object.fromEntries(value.ideaBuckets.map((group: any) => [group.kind, group.items.map((item: any) => item.text)]))
  })
}

async function open(page: Page) {
  await page.clock.install({ time: NOW })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
}

const card = (page: Page, kind: string) => page.locator(`.idea-group-card[data-idea-group="${kind}"]`)
const pane = (page: Page, kind: string) => page.locator(`.idea-group-pane[data-idea-pane="${kind}"]`)
const rows = (page: Page, kind: string) => pane(page, kind).locator('[data-plan-text-input]')
const sorter = (page: Page) => page.locator('.idea-sort[role="dialog"]')
// The sorter shows one card at a time; its progress bar counts the cards behind it.
async function expectIdea(page: Page, position: number, total: number) {
  const progress = sorter(page).getByRole('progressbar', { name: 'Ideas sorted' })
  await expect(progress).toHaveAttribute('aria-valuenow', String(position - 1))
  await expect(progress).toHaveAttribute('aria-valuemax', String(total))
  await expect(sorter(page).locator('.idea-sort-card')).toHaveCount(1)
}

test('group cards stay visible and each opens only its own ideas', async ({ page }, testInfo) => {
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic proposition')
    plannerStore.addIdea('Synthetic possible', 'possible')
    plannerStore.addIdea('Synthetic possible two', 'possible')
  `)
  await openView(page, 'Ideas')
  await expect(page.locator('.idea-group-card')).toHaveCount(5)
  await expect(card(page, 'proposition')).toHaveAttribute('aria-current', 'true')
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic proposition'])
  await expect(card(page, 'possible').locator('.idea-group-count')).toHaveText('2')

  await card(page, 'possible').click()
  await expect(rows(page, 'possible')).toHaveText(['Synthetic possible', 'Synthetic possible two'])
  await expect(page.locator('.idea-group-pane [data-plan-text-input]')).toHaveCount(2)

  // Selection stays within the open group and is dropped on leaving it.
  if (testInfo.project.name !== 'mobile') {
    await pane(page, 'possible').getByRole('button', { name: 'Select item' }).first().click()
    await expect(page.getByRole('group', { name: 'Move idea to' })).toBeVisible()
    await card(page, 'genuine').click()
    await expect(page.getByRole('group', { name: 'Move idea to' })).toHaveCount(0)
  }

  // The open group survives leaving the page and reloading.
  await card(page, 'possible').click()
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await openView(page, 'Ideas')
  await expect(rows(page, 'possible')).toHaveCount(2)

  // Long pages keep the cards in reach.
  await storeCall(page, `for (let index = 0; index < 60; index += 1) plannerStore.addIdea('Synthetic filler ' + index, 'possible')`)
  await rows(page, 'possible').last().scrollIntoViewIfNeeded()
  await expect(card(page, 'possible')).toBeInViewport()
})

test('links pasted into quick add are clickable, whatever their scheme', async ({ page }) => {
  await open(page)
  await page.evaluate(() => {
    ;(window as any).openedURLs = []
    window.open = ((url: string) => { (window as any).openedURLs.push(String(url)); return null }) as typeof window.open
  })
  await page.getByRole('button', { name: 'Add idea', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'New idea' })
  await expect(input).toBeFocused()
  await input.evaluate((element) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'See file:///tmp/synthetic.pdf, slack://channel?id=C1 and mailto:someone@example.com but not balance://nowhere.')
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })

  await expect(input.locator('a')).toHaveText(['file:///tmp/synthetic.pdf', 'slack://channel?id=C1', 'mailto:someone@example.com'])
  await input.locator('a').first().click()
  await expect.poll(() => page.evaluate(() => (window as any).openedURLs)).toEqual(['file:///tmp/synthetic.pdf'])
})

test('quick-added ideas land in Proposition Party and move with timed unlocks', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)

  await page.keyboard.press('Alt+A')
  const input = page.getByRole('textbox', { name: 'New idea' })
  await expect(input).toBeFocused()
  await input.fill('Synthetic idea two')
  await input.press('Enter')
  await expect(input).toBeHidden()
  await page.getByRole('button', { name: 'Add idea', exact: true }).click()
  // The newest idea goes on top.
  await input.fill('Synthetic idea one')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect(await groups(page)).toEqual({ proposition: ['Synthetic idea one', 'Synthetic idea two'] })

  await openView(page, 'Ideas')
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic idea one', 'Synthetic idea two'])
  await expect(pane(page, 'proposition').locator('.add-time')).toHaveCount(0)

  // A fresh selection shakes Genuinely instead of moving until its delay passes.
  await pane(page, 'proposition').getByRole('button', { name: 'Select item' }).first().click()
  const genuinely = page.getByRole('group', { name: 'Move idea to' }).getByRole('button', { name: /Genuinely/ })
  await expect(genuinely).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('g')
  await expect(genuinely).toHaveClass(/shaking/)
  expect(await groups(page)).toEqual({ proposition: ['Synthetic idea one', 'Synthetic idea two'] })
  await page.clock.fastForward(3000)
  await expect(genuinely).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('g')
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic idea two'])
  await card(page, 'genuine').click()
  await expect(rows(page, 'genuine')).toHaveText(['Synthetic idea one'])

  // Moves between the other groups are instant and undo restores them.
  await pane(page, 'genuine').getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('a')
  await expect(rows(page, 'genuine')).toHaveCount(0)
  await expect(card(page, 'afterlife').locator('.idea-group-count')).toHaveText('1')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(rows(page, 'genuine')).toHaveText(['Synthetic idea one'])

  // Rows edit like Today tasks and survive a reload.
  await rows(page, 'genuine').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' edited')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await openView(page, 'Ideas')
  await expect(rows(page, 'genuine')).toHaveText(['Synthetic idea one edited'])
})

test('Add item starts at the top of Proposition Party and the bottom of other groups', async ({ page }) => {
  await open(page)
  await openView(page, 'Ideas')
  await storeCall(page, `
    plannerStore.addIdea('Synthetic older')
    plannerStore.addIdea('Synthetic kept', 'genuine')
  `)

  await pane(page, 'proposition').getByRole('button', { name: '+ Add item' }).click()
  await expect(rows(page, 'proposition').first()).toBeFocused()
  await page.keyboard.type('Synthetic newest')
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic newest', 'Synthetic older'])

  await card(page, 'genuine').click()
  await pane(page, 'genuine').getByRole('button', { name: '+ Add item' }).click()
  await expect(rows(page, 'genuine').last()).toBeFocused()
  await page.keyboard.type('Synthetic appended')
  await expect(rows(page, 'genuine')).toHaveText(['Synthetic kept', 'Synthetic appended'])
})

test('Cmd+Shift+A selects the idea being edited', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await openView(page, 'Ideas')
  await storeCall(page, `
    plannerStore.addIdea('Synthetic second')
    plannerStore.addIdea('Synthetic first')
  `)

  await rows(page, 'proposition').nth(1).click()
  await page.keyboard.press('Meta+Shift+A')
  await expect(pane(page, 'proposition').locator('[data-plan-item-id].selected')).toHaveText(/Synthetic second/)
  await expect(page.getByRole('group', { name: 'Move idea to' })).toBeVisible()
  await expect(rows(page, 'proposition').nth(1)).not.toBeFocused()

  await page.keyboard.press('ArrowUp')
  await expect(pane(page, 'proposition').locator('[data-plan-item-id].selected')).toHaveText(/Synthetic first/)
})

test('quick add reopens the idea saved within the last 5 minutes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  const editLast = page.getByRole('button', { name: 'Edit last idea' })

  await page.keyboard.press('Alt+A')
  await expect(page.getByRole('textbox', { name: 'New idea' })).toBeFocused()
  await expect(editLast).toHaveCount(0)
  await page.keyboard.type('Synthetic draft')
  await page.keyboard.press('Enter')

  await page.clock.fastForward(280_000)
  await page.keyboard.press('Alt+A')
  await expect(editLast).toBeVisible()
  await page.keyboard.press('Alt+E')
  await expect(page.getByRole('dialog', { name: 'Edit idea' })).toBeVisible()
  await expect(editLast).toHaveCount(0)
  const input = page.getByRole('textbox', { name: 'Idea', exact: true })
  await expect(input).toHaveText('Synthetic draft')
  await expect(input).toBeFocused()
  await page.keyboard.type(' revised')
  await page.keyboard.press('Enter')
  await expect(input).toBeHidden()
  expect(await groups(page)).toEqual({ proposition: ['Synthetic draft revised'] })

  // Saving the edit restarts the window, so this is past five minutes since the idea was added.
  await page.clock.fastForward(280_000)
  await page.keyboard.press('Alt+A')
  await expect(editLast).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(editLast).toHaveCount(0)

  await page.clock.fastForward(21_000)
  await page.keyboard.press('Alt+A')
  await expect(page.getByRole('dialog', { name: 'Add idea' })).toBeVisible()
  await expect(editLast).toHaveCount(0)
})

test('a backdrop press keeps a half-written idea open', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Add idea', exact: true }).click()
  const input = page.getByRole('textbox', { name: 'New idea' })
  await input.fill('Synthetic unsaved')
  await page.locator('.overlay-backdrop:has([aria-label="New idea"])').click({ position: { x: 4, y: 4 } })
  await expect(input).toHaveText('Synthetic unsaved')
  await page.keyboard.press('Escape')
  await expect(input).toBeHidden()
})

test('a new day sorts every proposition one card at a time', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic keep')
    plannerStore.addIdea('Synthetic drop')
    plannerStore.addIdea('Synthetic frag')
    plannerStore.addIdea('ment')
  `)

  const dialog = sorter(page)
  await generateDay(page)
  await expect(dialog).toBeVisible()
  await expect(page.getByText('Is this worth the time and attention it would cost')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('region', { name: 'Daily plan' }).locator('[data-plan-text-input]')).toHaveCount(0)

  await generateDay(page)
  await expect(dialog).toBeVisible()
  await page.keyboard.press('y')
  const genuinely = page.getByRole('button', { name: /Genuinely Worth Doing/ })
  await page.keyboard.press('g')
  await expect(genuinely).toHaveClass(/shaking/)
  await expectIdea(page, 1, 4)
  await page.clock.fastForward(3000)
  await page.keyboard.press('g')
  await expectIdea(page, 2, 4)

  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await expectIdea(page, 3, 4)
  await page.keyboard.press('b')
  await expectIdea(page, 2, 4)
  await page.keyboard.press('n')
  await page.clock.fastForward(1000)
  await page.keyboard.press('a')
  await expectIdea(page, 3, 4)
  await page.keyboard.press('e')
  await page.getByRole('textbox', { name: 'Edit idea' }).fill('Synthetic frag edited')
  await page.keyboard.press('Enter')
  await page.keyboard.press('y')
  await page.clock.fastForward(3000)
  await page.keyboard.press('p')
  await expectIdea(page, 4, 4)
  await page.keyboard.press('m')
  await expect(dialog).toBeHidden()

  expect(await groups(page)).toEqual({
    proposition: [], genuine: ['Synthetic keep'], afterlife: ['Synthetic drop'], possible: ['Synthetic frag edited ment'], trash: [],
  })
  await expect(page.getByRole('region', { name: 'Daily plan' }).locator('[data-plan-text-input]').first()).toBeVisible()
})

test('sorting new ideas resumes after a reload until it is closed', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic first')
    plannerStore.addIdea('Synthetic second')
  `)
  const choice =page.locator('.empty-state').getByRole('button', { name: 'Default day' })

  await page.keyboard.press('Meta+Shift+D')
  await expectIdea(page, 1, 2)
  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await expectIdea(page, 2, 2)

  await page.reload()
  await expectIdea(page, 2, 2)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic second')
  await expect(choice).toHaveClass(/selected/)

  await page.keyboard.press('Escape')
  await expect(sorter(page)).toBeHidden()
  await page.reload()
  await expect(choice).toHaveClass(/selected/)
  await expect(sorter(page)).toBeHidden()

  await choice.click()
  await expectIdea(page, 2, 2)
  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await expect(sorter(page)).toBeHidden()
  await expect(page.getByRole('region', { name: 'Daily plan' }).locator('[data-plan-text-input]').first()).toBeVisible()
  await page.reload()
  await expect(sorter(page)).toBeHidden()
  await expect(page.getByRole('region', { name: 'Daily plan' }).locator('[data-plan-text-input]').first()).toBeVisible()
})

test('Back undoes the previous sort decision so an idea never lands in two places', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic first')
    plannerStore.addIdea('Synthetic second')
  `)
  const state =() => page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let value: any
    plannerStore.subscribe((current: any) => { value = current })()
    const ideas = value.ideaBuckets.flatMap((group: any) => group.items.map((item: any) => `${group.kind}:${item.text}${item.dayAssignmentDate ? '@day' : ''}`))
    return { ideas, notes: value.notes.length }
  })
  const initial = await state()

  await generateDay(page)
  await expectIdea(page, 1, 2)
  await page.keyboard.press('y')
  await page.keyboard.press('d')
  await expectIdea(page, 2, 2)
  await page.keyboard.press('b')
  await expectIdea(page, 1, 2)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic first')
  expect(await state()).toEqual(initial)

  // The undone idea stays out of the new day once it is sorted elsewhere.
  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await expect(sorter(page)).toBeHidden()
  expect(await groups(page)).toMatchObject({ proposition: [], trash: ['Synthetic first', 'Synthetic second'] })
  await expect(page.getByRole('region', { name: 'Daily plan' }).getByText('Synthetic first')).toHaveCount(0)
})

test('Back after a note or a group returns the idea to Proposition Party', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await openView(page, 'Ideas')
  await storeCall(page, `
    plannerStore.addIdea('Synthetic first')
    plannerStore.addIdea('Synthetic second')
    plannerStore.addIdea('Synthetic third')
  `)
  const notes = () => page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let value: any
    plannerStore.subscribe((current: any) => { value = current })()
    return value.notes.length
  })
  const initialNotes = await notes()

  await page.locator('.ideas-panel').getByRole('button', { name: 'Sort', exact: true }).click()
  await page.keyboard.press('y')
  await page.clock.fastForward(3000)
  await page.keyboard.press('p')
  await page.keyboard.press('y')
  await page.keyboard.press('n')
  await expectIdea(page, 3, 3)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic third')
  expect(await notes()).toBe(initialNotes + 1)

  await page.keyboard.press('b')
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic second')
  expect(await notes()).toBe(initialNotes)
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic third', 'Synthetic second'], possible: ['Synthetic first'] })

  await page.keyboard.press('b')
  await expectIdea(page, 1, 3)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic first')
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic third', 'Synthetic second', 'Synthetic first'], possible: [] })
  await expect(sorter(page).getByRole('button', { name: 'Back (B)' })).toBeDisabled()
})

test('the Proposition Party Sort button opens the sorter on demand', async ({ page }) => {
  await open(page)
  await openView(page, 'Ideas')
  const sort = page.locator('.ideas-panel').getByRole('button', { name: 'Sort', exact: true })
  await expect(sort).toBeDisabled()

  await storeCall(page, `
    plannerStore.addIdea('Synthetic sort one')
    plannerStore.addIdea('Synthetic sort two')
  `)
  await sort.click()
  await expectIdea(page, 1, 2)
  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await expectIdea(page, 2, 2)
  // A click outside the card closes the sorter, like every other modal.
  await page.locator('.overlay-backdrop:has(.idea-sort)').click({ position: { x: 4, y: 4 } })
  await expect(sorter(page)).toBeHidden()
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic sort two'], trash: ['Synthetic sort one'] })
})

test('the sorter stays with its page and cuts ideas to Trash and the clipboard', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The sidebar is a drawer on phones')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page)
  await openView(page, 'Ideas')
  await storeCall(page, `
    const id = plannerStore.addIdea('Synthetic cut me', 'proposition', '<strong>Synthetic cut me</strong>')
    const child = plannerStore.addIdea('Synthetic cut child')
    plannerStore.moveIdeaItem('bucket_proposition', child, id, 'inside')
    plannerStore.addIdea('Synthetic stay')
  `)
  await page.locator('.ideas-panel').getByRole('button', { name: 'Sort', exact: true }).click()
  await expectIdea(page, 1, 2)

  // The sidebar stays usable; returning to the page resumes the same sort.
  await openView(page, 'Today')
  await expect(sorter(page)).toBeHidden()
  await openView(page, 'Ideas')
  await expect(sorter(page)).toBeVisible()
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic cut me')

  await page.keyboard.press('y')
  await page.keyboard.press('x')
  await expectIdea(page, 2, 2)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic stay')
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic stay'], trash: ['Synthetic cut me'] })
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Synthetic cut child')
  const cutIdea = await storeCall(page, `
    let state
    plannerStore.subscribe(value => { state = value })()
    return state.ideaBuckets.find(b => b.kind === 'trash').items[0]
  `)
  expect(cutIdea).toMatchObject({ html: '<strong>Synthetic cut me</strong>', children: [{ text: 'Synthetic cut child' }], bucketedAt: expect.any(String) })

  await page.keyboard.press('b')
  await expectIdea(page, 1, 2)
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic stay', 'Synthetic cut me'], trash: [] })
  await page.keyboard.press('y')
  await page.keyboard.press('x')
  await page.reload()
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic stay'], trash: ['Synthetic cut me'] })
})

test('sorting moves ideas into new notes with their formatting and children, and supports undo', async ({ page }) => {
  await open(page)
  await storeCall(page, `
    const id = plannerStore.addIdea('Synthetic note', 'proposition', '<strong>Synthetic note</strong>')
    plannerStore.patchIdeaItem('bucket_proposition', id, { done: true })
    const child = plannerStore.addRootIdeaItem('bucket_proposition')
    plannerStore.patchIdeaItem('bucket_proposition', child, { text: 'Synthetic child', html: '<em>Synthetic child</em>' })
    plannerStore.moveIdeaItem('bucket_proposition', child, id, 'inside')
    plannerStore.addIdea('Synthetic second note')
  `)
  await openView(page, 'Ideas')
  await page.locator('.ideas-panel').getByRole('button', { name: 'Sort', exact: true }).click()
  await sorter(page).getByRole('button', { name: 'Yes (Y)' }).click()
  await sorter(page).getByRole('button', { name: 'Add to new note (N)' }).click()
  await expectIdea(page, 2, 2)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic second note')
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic second note'] })

  const notes = () => page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let state: any
    plannerStore.subscribe((value: any) => { state = value })()
    return state.notes
  })
  const created = await notes()
  expect(created).toHaveLength(1)
  expect(created[0]).toMatchObject({ title: 'Synthetic note', items: [{
    text: 'Synthetic note', html: '<strong>Synthetic note</strong>', done: true, kind: 'checklist',
    children: [{ text: 'Synthetic child', html: '<em>Synthetic child</em>', kind: 'checklist' }],
  }] })
  await sorter(page).getByRole('button', { name: 'Yes (Y)' }).click()
  await page.keyboard.press('n')
  await expect(sorter(page)).toBeHidden()
  expect(await notes()).toHaveLength(2)

  await storeCall(page, 'return plannerStore.undo()')
  expect(await notes()).toEqual(created)
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic second note'] })
  await storeCall(page, 'return plannerStore.redo()')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  expect(await notes()).toHaveLength(2)
  expect(await groups(page)).toMatchObject({ proposition: [] })
  await openView(page, 'Notes')
  await expect(page.locator('.note-text').first()).toHaveText('Synthetic second note')
})

test('a day generation sort can add ideas to the new day', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic for today')
    plannerStore.addIdea('Synthetic later')
  `)

  // Sorts outside generation have no day to add to.
  await openView(page, 'Ideas')
  await page.locator('.ideas-panel').getByRole('button', { name: 'Sort', exact: true }).click()
  await page.keyboard.press('y')
  await expect(sorter(page).getByRole('button', { name: 'Cut (X)' })).toBeVisible()
  await expect(sorter(page).getByRole('button', { name: 'Add to day (D)' })).toHaveCount(0)
  await page.keyboard.press('Escape')

  await generateDay(page)
  await expectIdea(page, 1, 2)
  await page.keyboard.press('y')
  await page.keyboard.press('d')
  await expectIdea(page, 2, 2)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic later')
  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await expect(sorter(page)).toBeHidden()

  const plan = page.getByRole('region', { name: 'Daily plan' })
  await expect(plan.locator('[data-plan-text-input]').first()).toHaveText('Synthetic for today')
  expect(await groups(page)).toMatchObject({ proposition: [], trash: ['Synthetic later'] })
})

test('day choices survive closing, navigation and reload without applying to another date', async ({ page }) => {
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic reserved')
    plannerStore.addIdea('Synthetic remaining')
  `)
  await generateDay(page)
  await page.keyboard.press('y')
  await page.keyboard.press('d')
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic remaining')
  await page.keyboard.press('Escape')

  await storeCall(page, 'return plannerStore.undo()')
  // Undo never reopens a sorter that was closed.
  await expect(sorter(page)).toBeHidden()
  await generateDay(page)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic reserved')
  await page.keyboard.press('Escape')
  await storeCall(page, 'return plannerStore.redo()')

  await openView(page, 'Ideas')
  await page.reload()
  // The reservation is scoped to October 8; October 9 must ask again.
  await storeCall(page, "plannerStore.setActivePlanDate('2026-10-09')")
  await generateDay(page)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic reserved')
  await page.keyboard.press('Escape')
  await storeCall(page, "plannerStore.setActivePlanDate('2026-10-08')")
  await generateDay(page)
  await expectIdea(page, 2, 2)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic remaining')
  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await expect(sorter(page)).toBeHidden()
  const plan = page.getByRole('region', { name: 'Daily plan' })
  await expect(plan.locator('[data-plan-text-input]').first()).toHaveText('Synthetic reserved')
  expect(await groups(page)).toMatchObject({ proposition: [], trash: ['Synthetic remaining'] })
})

test('a day keeps its sort progress across trash, cut and reopening', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic trash')
    plannerStore.addIdea('Synthetic cut')
    plannerStore.addIdea('Synthetic later')
  `)
  const hint = sorter(page).locator('.paste-review-hint')
  await generateDay(page)
  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await page.keyboard.press('y')
  await page.keyboard.press('x')
  await expectIdea(page, 3, 3)
  await expect(hint).toHaveText('2/3 sorted')
  await page.keyboard.press('Escape')

  // Reopening the same day continues, and a new idea joins the total.
  await storeCall(page, "plannerStore.addIdea('Synthetic new')")
  await generateDay(page)
  await expectIdea(page, 3, 4)
  await expect(hint).toHaveText('2/4 sorted')
})

test('pasted lists import as ideas and open the sorter; trash clears after 30 days', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await openView(page, 'Ideas')
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  const paste = page.getByRole('textbox', { name: 'Ideas to import' })
  await expect(paste).toBeFocused()
  await paste.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/html', '<div>Synthetic gamma<br>Synthetic delta</div><ul><li><p>Synthetic beta</p></li><li>Synthetic alpha<ul><li>Synthetic alpha child</li></ul></li></ul>')
    data.setData('text/plain', 'Synthetic gamma\nSynthetic delta\nSynthetic beta\nSynthetic alpha\n  Synthetic alpha child')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.getByRole('button', { name: /^Import 4 ideas/ }).click()
  await expectIdea(page, 1, 4)
  const child = sorter(page).locator('.idea-sort-child')
  await expect(child).toHaveText(['Synthetic alpha child'])
  // Children check off from the sorter like the idea itself, without advancing.
  await child.getByRole('checkbox', { name: 'Complete item' }).check()
  await expect(child.locator('.idea-sort-child-text')).toHaveClass(/done/)
  await expectIdea(page, 1, 4)
  await expect.poll(() => storeCall(page, "let value; plannerStore.subscribe((state) => { value = state })(); return value.ideaBuckets.find((group) => group.kind === 'proposition').items.find((item) => item.text === 'Synthetic alpha').children[0].done")).toBe(true)
  await page.keyboard.press('Escape')
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic gamma', 'Synthetic delta', 'Synthetic beta', 'Synthetic alpha', 'Synthetic alpha child'])

  // Balance task blocks and Apple Notes markup go through the notes paste parser.
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await paste.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/plain', '<balance>\n- Synthetic **task** one\n  - Synthetic sub task\n- Synthetic task two\n</balance>')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.getByRole('button', { name: /^Import 2 ideas/ }).click()
  await page.keyboard.press('Escape')
  await expect(rows(page, 'proposition').nth(0)).toHaveText('Synthetic **task** one')
  await expect(rows(page, 'proposition').nth(2)).toHaveText('Synthetic task two')

  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await paste.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/html', `<html><head><style>p.p1 {font: 20px 'Helvetica Neue'} li.li2 {font: 13px 'Helvetica Neue'}</style></head><body><p class="p1"><b>Synthetic apple title</b></p><ul class="ul1"><li class="li2">Synthetic apple bullet</li><li class="li2">Synthetic apple <i>second</i></li></ul></body></html>`)
    data.setData('text/plain', 'Synthetic apple title\n\t• Synthetic apple bullet\n\t• Synthetic apple second')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.getByRole('button', { name: /^Import 3 ideas/ }).click()
  await page.keyboard.press('Escape')
  await expect(rows(page, 'proposition').nth(0)).toHaveText('Synthetic apple title')
  await expect(rows(page, 'proposition').nth(2)).toHaveText('Synthetic apple second')
  await expect(rows(page, 'proposition').nth(2).locator('em')).toHaveText('second')

  await pane(page, 'proposition').locator('[data-plan-item-id]').filter({ hasText: 'Synthetic delta' }).getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('t')
  await expect(card(page, 'trash').locator('.idea-group-count')).toHaveText('1')
  await card(page, 'trash').click()
  await expect(rows(page, 'trash')).toHaveText(['Synthetic delta'])
  // The minute sweep runs against the moved clock.
  await page.clock.setSystemTime(new Date(NOW.getTime() + 29 * 24 * 60 * 60 * 1000))
  await page.clock.fastForward(60_000)
  await expect(rows(page, 'trash')).toHaveText(['Synthetic delta'])
  await page.clock.setSystemTime(new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000))
  await page.clock.fastForward(60_000)
  await expect(rows(page, 'trash')).toHaveCount(0)
})

test('the Genuinely review button sorts every idea in the group', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await storeCall(page, "plannerStore.addIdea('Synthetic reviewed', 'genuine'); plannerStore.addIdea('Synthetic later', 'genuine')")
  await openView(page, 'Ideas')
  await card(page, 'genuine').click()
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expectIdea(page, 1, 2)
  // Editing starts with the caret after the text rather than selecting it.
  await page.keyboard.press('e')
  const editor = page.getByRole('textbox', { name: 'Edit idea' })
  await expect(editor).toBeFocused()
  await page.keyboard.type('!')
  await expect(editor).toHaveText('Synthetic later!')
  await page.keyboard.press('Escape')
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic later')
  await expect(sorter(page).locator('.idea-sort-card')).not.toContainText('!')
  // Reviews keep the unlock delay, counted from the answer rather than the card.
  await page.clock.fastForward(5000)
  await page.keyboard.press('y')
  const genuinely = sorter(page).getByRole('button', { name: /Genuinely Worth Doing/ })
  await page.keyboard.press('g')
  await expect(genuinely).toHaveClass(/shaking/)
  await expectIdea(page, 1, 2)
  await page.clock.fastForward(3000)
  await page.keyboard.press('g')
  await expectIdea(page, 2, 2)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic reviewed')
  await page.keyboard.press('y')
  await page.clock.fastForward(3000)
  await page.keyboard.press('g')
  await expect(sorter(page)).toBeHidden()
  // Keeping an idea in Genuinely requeues it at the end of the group.
  expect((await groups(page)).genuine).toEqual(['Synthetic later', 'Synthetic reviewed'])
})

test('each scheduled group sets its review cadence from its card', async ({ page }, testInfo) => {
  // Phones show only the open group's cadence, in the page header.
  const mobile = testInfo.project.name === 'mobile'
  await open(page)
  await storeCall(page, "plannerStore.addIdea('Synthetic keep', 'genuine')")
  await openView(page, 'Ideas')
  await expect(page.getByRole('spinbutton', { name: /review days/ })).toHaveCount(mobile ? 0 : 2)
  if (mobile) await card(page, 'genuine').click()
  else await expect(page.getByRole('spinbutton', { name: 'Possibly Worth Doing review days' })).toHaveAttribute('aria-valuenow', '45')
  const genuine = page.getByRole('spinbutton', { name: 'Genuinely Worth Doing review days' })
  await expect(genuine).toHaveAttribute('aria-valuenow', '10')
  await expect(genuine).toHaveText('Every 10 days')
  // Dragging up raises the cadence, dragging down lowers it, one day per step.
  const box = (await genuine.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 + 56, { steps: 4 })
  await expect(genuine).toHaveText('Every 3 days')
  await page.mouse.up()
  await expect(genuine).toHaveAttribute('aria-valuenow', '3')
  // Arrow keys step it too.
  await genuine.focus()
  await page.keyboard.press('ArrowUp')
  await expect(genuine).toHaveAttribute('aria-valuenow', '4')
  await page.keyboard.press('ArrowDown')
  await expect(genuine).toHaveAttribute('aria-valuenow', '3')
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await openView(page, 'Ideas')
  await expect(genuine).toHaveAttribute('aria-valuenow', '3')

  await page.clock.setSystemTime(new Date(NOW.getTime() + 3 * 24 * 60 * 60 * 1000))
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await generateDay(page)
  await expect(sorter(page).locator('.idea-sort-intro')).toContainText('Every 3 days')
})

test('a due review blocks day generation until every older idea is sorted', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic keep', 'genuine')
    plannerStore.addIdea('Synthetic today', 'genuine')
    plannerStore.addIdea('Synthetic maybe', 'possible')
  `)
  await page.clock.setSystemTime(new Date(NOW.getTime() + 10 * 24 * 60 * 60 * 1000))
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  // Ideas placed on the due day wait for the next review.
  await storeCall(page, "plannerStore.addIdea('Synthetic fresh', 'genuine')")
  const generated = () => page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).plans.some((plan: any) => plan.date === '2026-10-18'))

  const intro = sorter(page).locator('.idea-sort-intro')
  await generateDay(page)
  await expect(sorter(page)).toContainText('Review Genuinely Worth Doing')
  await expect(intro).toContainText('2 ideas')
  await expect(intro).toContainText('Every 10 days')
  await page.keyboard.press('Escape')
  await expect(sorter(page)).toBeHidden()
  expect(await generated()).toBe(false)

  await generateDay(page)
  await page.keyboard.press('Enter')
  await expectIdea(page, 1, 2)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic today')
  await page.keyboard.press('y')
  await page.clock.fastForward(3000)
  await page.keyboard.press('g')
  await expectIdea(page, 2, 2)
  await page.keyboard.press('Escape')
  expect(await generated()).toBe(false)

  // Decisions stick, so the review resumes with the rest.
  await generateDay(page)
  await expect(intro).toContainText('1 idea')
  await page.keyboard.press('Enter')
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic keep')
  await page.keyboard.press('y')
  await page.keyboard.press('d')
  await expect(sorter(page)).toBeHidden()
  const plan = page.getByRole('region', { name: 'Daily plan' })
  await expect(plan.locator('[data-plan-text-input]').first()).toHaveText('Synthetic keep')
  expect(await groups(page)).toMatchObject({ genuine: ['Synthetic fresh', 'Synthetic today'], possible: ['Synthetic maybe'] })
})

test('sort new ideas opens web links by click and Option-F without advancing', async ({ page }) => {
  await open(page)
  await storeCall(page, `
    const id = plannerStore.addIdea('Synthetic first and second')
    let state
    plannerStore.subscribe(value => { state = value })()
    const group = state.ideaBuckets.find(group => group.kind === 'proposition')
    plannerStore.patchIdeaItem(group.id, id, {
      html: 'Synthetic <a href="https://example.com/first">first</a> and <a href="https://example.com/second">second</a>',
    })
  `)
  await page.evaluate(() => {
    ;(window as any).openedURLs = []
    window.open = ((url?: string | URL) => {
      ;(window as any).openedURLs.push(String(url))
      return null
    }) as typeof window.open
  })
  await generateDay(page)
  await expect(sorter(page)).toBeVisible()
  await sorter(page).getByRole('link', { name: 'second', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).openedURLs)).toEqual(['https://example.com/second'])
  await page.evaluate(() => {
    const shortcut = { key: 'ƒ', code: 'KeyF', altKey: true, bubbles: true, cancelable: true }
    window.dispatchEvent(new KeyboardEvent('keydown', shortcut))
    window.dispatchEvent(new KeyboardEvent('keydown', shortcut))
  })
  await expect.poll(() => page.evaluate(() => (window as any).openedURLs))
    .toEqual(['https://example.com/second', 'https://example.com/first'])
  await expectIdea(page, 1, 1)
  await page.keyboard.press('e')
  await page.clock.fastForward(600)
  await page.keyboard.press('Alt+f')
  expect(await page.evaluate(() => (window as any).openedURLs)).toHaveLength(2)
  await expect(sorter(page).getByRole('textbox', { name: 'Edit idea' })).toBeFocused()
})

test('sort new ideas edits rich text, keeping line breaks and links', async ({ page }) => {
  await open(page)
  await storeCall(page, `
    const id = plannerStore.addIdea('Synthetic linesite tail')
    let state
    plannerStore.subscribe(value => { state = value })()
    const group = state.ideaBuckets.find(group => group.kind === 'proposition')
    plannerStore.patchIdeaItem(group.id, id, {
      html: 'Synthetic line<br><a href="https://example.com/site">site</a> tail',
    })
  `)
  await page.evaluate(() => {
    ;(window as any).openedURLs = []
    window.open = ((url?: string | URL) => {
      ;(window as any).openedURLs.push(String(url))
      return null
    }) as typeof window.open
  })
  await generateDay(page)
  await expect(sorter(page)).toBeVisible()
  await page.keyboard.press('e')
  const editor = sorter(page).getByRole('textbox', { name: 'Edit idea' })
  await expect(editor).toBeFocused()
  await expect(editor.locator('br')).toHaveCount(1)
  await editor.getByRole('link', { name: 'site', exact: true }).click()
  await expect.poll(() => page.evaluate(() => (window as any).openedURLs)).toEqual(['https://example.com/site'])

  await editor.click()
  await page.keyboard.press('ControlOrMeta+End')
  await page.keyboard.press('Shift+Enter')
  await page.keyboard.type('Synthetic third')
  await page.keyboard.press('Enter')
  await expect(editor).toBeHidden()

  const card = sorter(page).locator('.idea-sort-card .paste-review-text')
  await expect(card.locator('br')).toHaveCount(2)
  await expect(card.getByRole('link', { name: 'site', exact: true })).toHaveAttribute('href', 'https://example.com/site')
  await expect(card).toContainText('Synthetic third')
  await expect(sorter(page)).toBeVisible()
})

for (const method of ['click', 'shortcut']) {
  test(`sort new ideas follows a Balance link by ${method}`, async ({ page }) => {
    await open(page)
    await storeCall(page, `plannerStore.addIdea('balance://goals/stats')`)
    await generateDay(page)
    await expect(sorter(page).getByRole('link', { name: 'balance://goals/stats', exact: true })).toBeVisible()
    if (method === 'click') await sorter(page).getByRole('link', { name: 'balance://goals/stats', exact: true }).click()
    else await page.keyboard.press('Alt+f')
    await expect(page.getByRole('heading', { name: 'Goal stats', exact: true })).toBeVisible()
  })
}

test('idea deletion keeps content in Trash until it is deleted there', async ({ page }) => {
  await open(page)
  await storeCall(page, `
    const parent = plannerStore.addIdea('Synthetic parent', 'genuine', '<strong>Synthetic parent</strong>')
    const child = plannerStore.addIdea('Synthetic child', 'genuine')
    plannerStore.moveIdeaItem('bucket_genuine', child, parent, 'inside')
    plannerStore.deleteIdeaItem('bucket_genuine', child)
  `)
  expect(await groups(page)).toMatchObject({ genuine: ['Synthetic parent'], trash: ['Synthetic child'] })
  await storeCall(page, `
    let state
    plannerStore.subscribe(value => { state = value })()
    const child = state.ideaBuckets.find(b => b.kind === 'trash').items[0]
    plannerStore.deleteIdeaItem('bucket_trash', child.id)
  `)
  expect(await groups(page)).toMatchObject({ trash: [] })
  await storeCall(page, `
    let state
    plannerStore.subscribe(value => { state = value })()
    const parent = state.ideaBuckets.find(b => b.kind === 'genuine').items[0]
    const child = plannerStore.addIdea('Synthetic retained child', 'genuine')
    plannerStore.moveIdeaItem('bucket_genuine', child, parent.id, 'inside')
    plannerStore.deleteIdeaItemPreservingChildren('bucket_genuine', parent.id)
  `)
  expect(await groups(page)).toMatchObject({ genuine: ['Synthetic retained child'], trash: ['Synthetic parent'] })
  await page.reload()
  const trashed = await storeCall(page, `
    let state
    plannerStore.subscribe(value => { state = value })()
    return state.ideaBuckets.find(b => b.kind === 'trash').items[0]
  `)
  expect(trashed).toMatchObject({ html: '<strong>Synthetic parent</strong>', children: [], bucketedAt: expect.any(String) })
})

test('Cmd+D toggles ideas done like Today tasks', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic first', 'genuine')
    plannerStore.addIdea('Synthetic second', 'genuine')
  `)
  await openView(page, 'Ideas')
  await card(page, 'genuine').click()
  const ideaRows = pane(page, 'genuine').locator('[data-plan-item-id]')
  const checkbox = (index: number) => ideaRows.nth(index).getByRole('checkbox').first()

  // Completing the idea being edited moves the caret to the idea below.
  await rows(page, 'genuine').first().click()
  await page.keyboard.press('ControlOrMeta+d')
  await expect(checkbox(0)).toBeChecked()
  await expect(rows(page, 'genuine').nth(1)).toBeFocused()

  // A selected idea toggles and stays selected; undo restores it.
  await pane(page, 'genuine').getByRole('button', { name: 'Select item' }).nth(1).click()
  await page.keyboard.press('ControlOrMeta+d')
  await expect(checkbox(1)).toBeChecked()
  await page.keyboard.press('ControlOrMeta+d')
  await expect(checkbox(1)).not.toBeChecked()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(checkbox(1)).toBeChecked()
})

test('deleting ideas from the keyboard moves them to Trash; blank rows are discarded', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await openView(page, 'Ideas')
  await storeCall(page, `
    plannerStore.addIdea('Synthetic selected', 'genuine')
    plannerStore.addIdea('Synthetic line end', 'genuine')
    plannerStore.addIdea('Synthetic cleared', 'genuine')
  `)
  await card(page, 'genuine').click()
  await expect(rows(page, 'genuine')).toHaveCount(3)

  await pane(page, 'genuine').locator('.select-handle').first().click()
  await page.keyboard.press('Backspace')
  expect(await groups(page)).toMatchObject({ genuine: ['Synthetic line end', 'Synthetic cleared'], trash: ['Synthetic selected'] })

  await rows(page, 'genuine').first().click()
  await page.keyboard.press('End')
  await page.keyboard.press('Meta+Backspace')
  expect(await groups(page)).toMatchObject({ genuine: ['Synthetic cleared'], trash: ['Synthetic selected', 'Synthetic line end'] })

  await rows(page, 'genuine').first().click()
  await page.keyboard.press('Meta+a')
  await page.keyboard.press('Backspace')
  await page.keyboard.press('Backspace')
  expect(await groups(page)).toMatchObject({ genuine: [], trash: ['Synthetic selected', 'Synthetic line end'] })

  // Deleting from Trash discards the idea.
  await card(page, 'trash').click()
  await pane(page, 'trash').locator('.select-handle').first().click()
  await page.keyboard.press('Backspace')
  expect(await groups(page)).toMatchObject({ trash: ['Synthetic line end'] })
})

test('the idea options menu copies, cuts and pastes ideas', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'The task options menu is phone-only')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'])
  await open(page)
  await openView(page, 'Ideas')
  await storeCall(page, `
    plannerStore.addIdea('Synthetic first', 'genuine')
    plannerStore.addIdea('Synthetic second', 'genuine')
  `)
  await card(page, 'genuine').click()
  const menuItem = async (text: string, action: string) => {
    await pane(page, 'genuine').getByRole('button', { name: `Task options for ${text}` }).first().click()
    await page.getByRole('menu', { name: `Options for ${text}` }).getByRole('menuitem', { name: action, exact: true }).click()
  }

  await menuItem('Synthetic first', 'Copy')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Synthetic first')
  await menuItem('Synthetic second', 'Paste')
  await expect.poll(async () => (await groups(page)).genuine).toEqual(['Synthetic first', 'Synthetic second', 'Synthetic first'])

  // Cut leaves the idea in Trash until it is pasted where it belongs.
  await menuItem('Synthetic second', 'Cut')
  await expect.poll(async () => (await groups(page)).trash).toEqual(['Synthetic second'])
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Synthetic second')
  await menuItem('Synthetic first', 'Paste')
  await expect.poll(async () => (await groups(page)).genuine).toEqual(['Synthetic first', 'Synthetic second', 'Synthetic first'])
})
