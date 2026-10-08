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

async function buckets(page: Page): Promise<Record<string, string[]>> {
  return page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let value: any
    plannerStore.subscribe((state: any) => { value = state })()
    return Object.fromEntries(value.ideaBuckets.map((bucket: any) => [bucket.kind, bucket.items.map((item: any) => item.text)]))
  })
}

async function open(page: Page) {
  await page.clock.install({ time: NOW })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
}

const card = (page: Page, kind: string) => page.locator(`.bucket-card[data-bucket="${kind}"]`)
const rows = (page: Page, kind: string) => card(page, kind).locator('[data-plan-text-input]')

test('quick-added ideas land in Proposition Party and move with timed unlocks', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)

  await page.keyboard.press('Alt+K')
  const input = page.getByRole('textbox', { name: 'New idea' })
  await expect(input).toBeFocused()
  await input.fill('Synthetic idea one')
  await input.press('Enter')
  await expect(input).toBeHidden()
  await page.getByRole('button', { name: 'Add idea', exact: true }).click()
  await input.fill('Synthetic idea two')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  expect(await buckets(page)).toEqual({ proposition: ['Synthetic idea one', 'Synthetic idea two'] })

  await openView(page, 'Buckets')
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic idea one', 'Synthetic idea two'])
  await expect(card(page, 'proposition').locator('.add-time')).toHaveCount(0)

  // A fresh selection shakes Genuinely instead of moving until its delay passes.
  await card(page, 'proposition').getByRole('button', { name: 'Select item' }).first().click()
  const genuinely = page.getByRole('group', { name: 'Move idea to' }).getByRole('button', { name: /Genuinely/ })
  await expect(genuinely).toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('g')
  await expect(genuinely).toHaveClass(/shaking/)
  expect(await buckets(page)).toEqual({ proposition: ['Synthetic idea one', 'Synthetic idea two'] })
  await page.clock.fastForward(3000)
  await expect(genuinely).not.toHaveAttribute('aria-disabled', 'true')
  await page.keyboard.press('g')
  await expect(rows(page, 'genuine')).toHaveText(['Synthetic idea one'])
  await expect(rows(page, 'proposition')).toHaveText(['Synthetic idea two'])

  // Moves between the other buckets are instant and undo restores them.
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
  await openView(page, 'Buckets')
  await expect(rows(page, 'genuine')).toHaveText(['Synthetic idea one edited'])
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

  const dialog = page.getByRole('dialog', { name: /Idea 1 of 4/ })
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
  await expect(page.getByRole('heading', { name: 'Idea 1 of 4' })).toBeVisible()
  await page.clock.fastForward(3000)
  await page.keyboard.press('g')
  await expect(page.getByRole('heading', { name: 'Idea 2 of 4' })).toBeVisible()

  await page.keyboard.press('n')
  await page.keyboard.press('t')
  await expect(page.getByRole('heading', { name: 'Idea 3 of 4' })).toBeVisible()
  await page.keyboard.press('b')
  await expect(page.getByRole('heading', { name: 'Idea 2 of 4' })).toBeVisible()
  await page.keyboard.press('n')
  await page.keyboard.press('a')
  await expect(page.getByRole('heading', { name: 'Idea 3 of 4' })).toBeVisible()
  await page.keyboard.press('e')
  await page.getByRole('textbox', { name: 'Edit idea' }).fill('Synthetic frag edited')
  await page.keyboard.press('Enter')
  await page.keyboard.press('y')
  await page.clock.fastForward(3000)
  await page.keyboard.press('p')
  await expect(page.getByRole('heading', { name: 'Idea 4 of 4' })).toBeVisible()
  await page.keyboard.press('m')
  await expect(dialog).toBeHidden()

  expect(await buckets(page)).toEqual({
    proposition: [], genuine: ['Synthetic keep'], afterlife: ['Synthetic drop'], possible: ['Synthetic frag edited ment'], trash: [],
  })
  await expect(page.getByRole('region', { name: 'Daily plan' }).locator('[data-plan-text-input]').first()).toBeVisible()
})

test('pasted lists import as ideas and open the sorter; trash clears after 30 days', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard flow is covered on desktop')
  await open(page)
  await openView(page, 'Buckets')
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
  await expect(page.getByRole('dialog', { name: /Idea 1 of 4/ })).toBeVisible()
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
  expect(goal.nameHtml).toContain('balance://buckets/review')

  await storeCall(page, "plannerStore.addIdea('Synthetic reviewed', 'genuine')")
  // The goal name carries the link that starts the review.
  await openView(page, 'Goals')
  await page.locator('.goal-name-input a[href="balance://buckets/review"]').click()
  await expect(page.getByRole('dialog', { name: /Idea 1 of 1/ })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('heading', { name: 'Buckets', level: 2 })).toBeVisible()
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(page.getByRole('dialog', { name: /Idea 1 of 1/ })).toBeVisible()
  await page.keyboard.press('y')
  await page.keyboard.press('g')
  await expect(page.getByRole('dialog', { name: /Idea 1 of 1/ })).toBeHidden()
  const todayTasks = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).plans[0].items.map((item: any) => [item.text, item.done]))
  expect(todayTasks).toContainEqual(['Filter Genuinely Worth Doing', true])
})
