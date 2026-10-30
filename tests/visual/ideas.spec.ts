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
const rows = (page: Page, kind: string) => card(page, kind).locator('[data-plan-text-input]')
const sorter = (page: Page) => page.locator('.idea-sort[role="dialog"]')
// The sorter shows one card at a time; its progress bar counts the cards behind it.
async function expectIdea(page: Page, position: number, total: number) {
  const progress = sorter(page).getByRole('progressbar', { name: 'Ideas sorted' })
  await expect(progress).toHaveAttribute('aria-valuenow', String(position - 1))
  await expect(progress).toHaveAttribute('aria-valuemax', String(total))
  await expect(sorter(page).locator('.idea-sort-card')).toHaveCount(1)
}

test('quick-added ideas land in Proposition Party and move with timed unlocks', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)

  await page.keyboard.press('Alt+A')
  const input = page.getByRole('textbox', { name: 'New idea' })
  await expect(input).toBeFocused()
  await input.fill('Synthetic idea one')
  await input.press('Enter')
  await expect(input).toBeHidden()
  await page.getByRole('button', { name: 'Add idea', exact: true }).click()
  await input.fill('Synthetic idea two')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect(await groups(page)).toEqual({ proposition: ['Synthetic idea one', 'Synthetic idea two'] })

  await openView(page, 'Ideas')
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic idea one', 'Synthetic idea two'])
  await expect(card(page, 'proposition').locator('.add-time')).toHaveCount(0)

  // A fresh selection shakes Genuinely instead of moving until its delay passes.
  await card(page, 'proposition').getByRole('button', { name: 'Select item' }).first().click()
  const genuinely = page.getByRole('group', { name: 'Move idea to' }).getByRole('button', { name: /Genuinely/ })
  await expect(genuinely).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('g')
  await expect(genuinely).toHaveClass(/shaking/)
  expect(await groups(page)).toEqual({ proposition: ['Synthetic idea one', 'Synthetic idea two'] })
  await page.clock.fastForward(3000)
  await expect(genuinely).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('g')
  await expect(rows(page, 'genuine')).toHaveText(['Synthetic idea one'])
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic idea two'])

  // Moves between the other groups are instant and undo restores them.
  await card(page, 'genuine').getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('a')
  await expect(rows(page, 'afterlife')).toHaveText(['Synthetic idea one'])
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

test('quick add reopens the idea added within the last 4 minutes', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  const editLast = page.getByRole('button', { name: 'Edit last idea' })

  await page.keyboard.press('Alt+A')
  await expect(page.getByRole('textbox', { name: 'New idea' })).toBeFocused()
  await expect(editLast).toHaveCount(0)
  await page.keyboard.type('Synthetic draft')
  await page.keyboard.press('Enter')

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

  await page.clock.fastForward(241_000)
  await page.keyboard.press('Alt+A')
  await expect(page.getByRole('dialog', { name: 'Add idea' })).toBeVisible()
  await expect(editLast).toHaveCount(0)
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

test('Back undoes the previous sort decision so an idea never lands in two places', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await storeCall(page, `
    plannerStore.addIdea('Synthetic first')
    plannerStore.addIdea('Synthetic second')
  `)
  const state = () => page.evaluate(async () => {
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

  await card(page, 'proposition').getByRole('button', { name: 'Sort', exact: true }).click()
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
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic second', 'Synthetic third'], possible: ['Synthetic first'] })

  await page.keyboard.press('b')
  await expectIdea(page, 1, 3)
  await expect(sorter(page).locator('.idea-sort-card')).toContainText('Synthetic first')
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic first', 'Synthetic second', 'Synthetic third'], possible: [] })
  await expect(sorter(page).getByRole('button', { name: 'Back (B)' })).toBeDisabled()
})

test('the Proposition Party Sort button opens the sorter on demand', async ({ page }) => {
  await open(page)
  await openView(page, 'Ideas')
  const sort = card(page, 'proposition').getByRole('button', { name: 'Sort', exact: true })
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
  await card(page, 'proposition').getByRole('button', { name: 'Sort', exact: true }).click()
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
  expect(await groups(page)).toMatchObject({ proposition: ['Synthetic cut me', 'Synthetic stay'], trash: [] })
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
  await card(page, 'proposition').getByRole('button', { name: 'Sort', exact: true }).click()
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
  await card(page, 'proposition').getByRole('button', { name: 'Sort', exact: true }).click()
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
    data.setData('text/html', '<ul><li>Synthetic alpha<ul><li>Synthetic alpha child</li></ul></li><li><p>Synthetic beta</p></li></ul><div>Synthetic gamma<br>Synthetic delta</div>')
    data.setData('text/plain', 'Synthetic alpha\n  Synthetic alpha child\nSynthetic beta\nSynthetic gamma\nSynthetic delta')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.getByRole('button', { name: /^Import 4 ideas/ }).click()
  await expectIdea(page, 1, 4)
  await expect(page.locator('.idea-sort-children li')).toHaveText(['Synthetic alpha child'])
  await page.keyboard.press('Escape')
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic alpha', 'Synthetic alpha child', 'Synthetic beta', 'Synthetic gamma', 'Synthetic delta'])

  // Balance task blocks and Apple Notes markup go through the notes paste parser.
  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await paste.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/plain', '<balance>\n- Synthetic **task** one\n  - Synthetic sub task\n- Synthetic task two\n</balance>')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.getByRole('button', { name: /^Import 2 ideas/ }).click()
  await page.keyboard.press('Escape')
  await expect(rows(page, 'proposition').nth(5)).toHaveText('Synthetic **task** one')
  await expect(rows(page, 'proposition').nth(7)).toHaveText('Synthetic task two')

  await page.getByRole('button', { name: 'Import', exact: true }).click()
  await paste.evaluate((element) => {
    const data = new DataTransfer()
    data.setData('text/html', `<html><head><style>p.p1 {font: 20px 'Helvetica Neue'} li.li2 {font: 13px 'Helvetica Neue'}</style></head><body><p class="p1"><b>Synthetic apple title</b></p><ul class="ul1"><li class="li2">Synthetic apple bullet</li><li class="li2">Synthetic apple <i>second</i></li></ul></body></html>`)
    data.setData('text/plain', 'Synthetic apple title\n\t• Synthetic apple bullet\n\t• Synthetic apple second')
    element.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await page.getByRole('button', { name: /^Import 3 ideas/ }).click()
  await page.keyboard.press('Escape')
  await expect(rows(page, 'proposition').nth(8)).toHaveText('Synthetic apple title')
  await expect(rows(page, 'proposition').nth(10)).toHaveText('Synthetic apple second')
  await expect(rows(page, 'proposition').nth(10).locator('em')).toHaveText('second')

  await card(page, 'proposition').locator('[data-plan-item-id]').filter({ hasText: 'Synthetic delta' }).getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('t')
  // Trash stays collapsed until its header is clicked.
  await expect(card(page, 'trash').locator('.idea-group-count')).toHaveText('1')
  await expect(rows(page, 'trash')).toHaveCount(0)
  await card(page, 'trash').getByRole('button', { name: 'Trash' }).click()
  await expect(rows(page, 'trash')).toHaveText(['Synthetic delta'])
  // The minute sweep runs against the moved clock.
  await page.clock.setSystemTime(new Date(NOW.getTime() + 29 * 24 * 60 * 60 * 1000))
  await page.clock.fastForward(60_000)
  await expect(rows(page, 'trash')).toHaveText(['Synthetic delta'])
  await page.clock.setSystemTime(new Date(NOW.getTime() + 31 * 24 * 60 * 60 * 1000))
  await page.clock.fastForward(60_000)
  await expect(rows(page, 'trash')).toHaveCount(0)
})

test('the review goal seeds once with a link that runs the Genuinely review', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await generateDay(page)
  expect(await storeCall(page, 'return [plannerStore.ensureIdeaReviewGoal(), plannerStore.ensureIdeaReviewGoal()]')).toEqual([true, false])
  const goal = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).goals.find((goal: any) => goal.id === 'goal_idea_review'))
  expect(goal).toBeTruthy()
  expect(goal.cadenceDays).toBe(7)
  expect(goal.nameHtml).toContain('balance://ideas/review')

  await storeCall(page, "plannerStore.addIdea('Synthetic reviewed', 'genuine'); plannerStore.addIdea('Synthetic later', 'genuine')")
  // The goal name carries the link that starts the review.
  await openView(page, 'Goals')
  await page.locator('.goal-name-input a[href="balance://ideas/review"]').click()
  await expectIdea(page, 1, 2)
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Ideas', level: 2 })).toBeVisible()
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expectIdea(page, 1, 2)
  // Editing starts with the caret after the text rather than selecting it.
  await page.keyboard.press('e')
  const editor = page.getByRole('textbox', { name: 'Edit idea' })
  await expect(editor).toBeFocused()
  expect(await editor.evaluate((input: HTMLTextAreaElement) => [input.selectionStart, input.selectionEnd])).toEqual([18, 18])
  await page.keyboard.press('Escape')
  // Reviews keep the unlock delay, counted from the answer rather than the card.
  await page.clock.fastForward(5000)
  await page.keyboard.press('y')
  const genuinely = page.getByRole('button', { name: /Genuinely Worth Doing/ })
  await page.keyboard.press('g')
  await expect(genuinely).toHaveClass(/shaking/)
  await expectIdea(page, 1, 2)
  await page.clock.fastForward(3000)
  await page.keyboard.press('g')
  await expectIdea(page, 2, 2)
  // Keeping an idea in Genuinely requeues it at the end of the group.
  expect((await groups(page)).genuine).toEqual(['Synthetic later', 'Synthetic reviewed'])
  await page.keyboard.press('y')
  await page.clock.fastForward(3000)
  await page.keyboard.press('p')
  await expect(sorter(page)).toBeHidden()
  expect((await groups(page)).genuine).toEqual(['Synthetic reviewed'])
  const todayTasks = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).plans[0].items.map((item: any) => [item.text, item.done]))
  expect(todayTasks).toContainEqual(['Filter Genuinely Worth Doing', true])
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
  const ideaRows = card(page, 'genuine').locator('[data-plan-item-id]')
  const checkbox = (index: number) => ideaRows.nth(index).getByRole('checkbox').first()

  // Completing the idea being edited moves the caret to the idea below.
  await rows(page, 'genuine').first().click()
  await page.keyboard.press('ControlOrMeta+d')
  await expect(checkbox(0)).toBeChecked()
  await expect(rows(page, 'genuine').nth(1)).toBeFocused()

  // A selected idea toggles and stays selected; undo restores it.
  await card(page, 'genuine').getByRole('button', { name: 'Select item' }).nth(1).click()
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
  await expect(rows(page, 'genuine')).toHaveCount(3)

  await card(page, 'genuine').locator('.select-handle').first().click()
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
  await card(page, 'trash').getByRole('button', { name: 'Trash' }).click()
  await card(page, 'trash').locator('.select-handle').first().click()
  await page.keyboard.press('Backspace')
  expect(await groups(page)).toMatchObject({ trash: ['Synthetic line end'] })
})
