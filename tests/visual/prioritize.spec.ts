import { expect, test, type Page } from '@playwright/test'
import { openView } from '../helpers/navigation'

test.use({ timezoneId: 'America/Vancouver' })

// 11 a.m. in Vancouver, well clear of the 5 a.m. day boundary.
const NOW = new Date('2026-09-09T18:00:00Z')

async function storeCall(page: Page, script: string) {
  await page.evaluate(async (body) => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    new Function('plannerStore', body)(plannerStore)
  }, script)
}

// The overdue goal is created three weeks earlier, so the app opens on a
// clock that is then moved to NOW.
async function seed(page: Page) {
  await page.clock.install({ time: new Date('2026-08-20T18:00:00Z') })
  await page.goto('/')
  await storeCall(page, "plannerStore.addGoal('Synthetic overdue goal', 7, [], 40)")
  await page.clock.setSystemTime(NOW)
  await page.evaluate(() => window.dispatchEvent(new Event('focus')))
  await storeCall(page, `
    plannerStore.addProject('Synthetic alpha')
    const archived = plannerStore.addProject('Synthetic archived')
    plannerStore.updateProject(archived, { archived: true })
    const finished = plannerStore.addProject('Synthetic finished')
    plannerStore.checkInProject(finished, 100, 50)
    plannerStore.addProject('Synthetic beta')
    plannerStore.addGoal('Synthetic monthly goal', 30, [], 120)
    plannerStore.addGoal('Synthetic daily goal', 1, [], 200)
    const retired = plannerStore.addGoal('Synthetic retired goal', 2, [], 300)
    plannerStore.setGoalActive(retired, false, '2026-09-09')
  `)
}

async function sessions(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let value: any
    plannerStore.subscribe((state: any) => { value = state.prioritySessions })()
    return value
  })
}

const rows = (page: Page) => page.locator('.priority-list li')

async function expectRows(page: Page, expected: string[]) {
  await expect(rows(page)).toHaveText(expected.map((text, index) => new RegExp(`^\\s*${index + 1}\\s*${text}\\s*$`)))
}

test('keyboard prioritizing reorders, persists, undoes and times out', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Touch entry is covered separately')
  await seed(page)
  await openView(page, 'Prioritize')
  await expect(page.getByRole('button', { name: 'Past sessions' })).toHaveCount(0)
  // Archived and completed projects, inactive goals, and goals not yet due are left out.
  await page.getByRole('button', { name: 'Start prioritizing' }).click()

  const add = page.getByRole('textbox', { name: 'Add priority' })
  const number = page.locator('.prioritize-number')
  await expectRows(page, ['Synthetic alpha', 'Synthetic beta', 'Synthetic overdue goal', 'Synthetic daily goal'])
  await expect(number).toBeFocused()

  await page.keyboard.type('3')
  await page.keyboard.press('Enter')
  await page.keyboard.type('12')
  await expectRows(page, ['Synthetic beta\\s*12', 'Synthetic alpha\\s*3', 'Synthetic overdue goal', 'Synthetic daily goal'])
  await expect(rows(page).first()).toHaveClass(/selected/)

  // Backspace edits the selected value; Enter skips to the next unrated row.
  await page.keyboard.press('Backspace')
  await expectRows(page, ['Synthetic alpha\\s*3', 'Synthetic beta\\s*1', 'Synthetic overdue goal', 'Synthetic daily goal'])
  await page.keyboard.press('Enter')
  await expect(rows(page).nth(2)).toHaveClass(/selected/)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(rows(page).nth(3)).toHaveClass(/selected/)

  // Letters go to the add field, where Shift or Ctrl types a digit. Enter
  // adds, selects, and returns to the number.
  await page.keyboard.type('Synthetic new v')
  await expect(add).toBeFocused()
  await page.keyboard.press('Shift+Digit2')
  await expect(add).toHaveValue('Synthetic new v2')
  await page.keyboard.press('Enter')
  await expect(add).toHaveValue('')
  await expect(number).toBeFocused()
  await expect(rows(page).last()).toHaveText(/Synthetic new v2\s*$/)
  await expect(rows(page).last()).toHaveClass(/selected/)
  await page.keyboard.type('2')
  await expectRows(page, ['Synthetic alpha\\s*3', 'Synthetic new v2\\s*2', 'Synthetic beta\\s*1', 'Synthetic overdue goal', 'Synthetic daily goal'])

  // A plain digit always moves to the number and appends to it.
  await page.keyboard.press('Tab')
  await expect(add).toBeFocused()
  await page.keyboard.type('abc4')
  await expect(number).toBeFocused()
  await expect(add).toHaveValue('abc')
  await expectRows(page, ['Synthetic new v2\\s*24', 'Synthetic alpha\\s*3', 'Synthetic beta\\s*1', 'Synthetic overdue goal', 'Synthetic daily goal'])
  await page.keyboard.press('ControlOrMeta+Backspace')
  await expectRows(page, ['Synthetic alpha\\s*3', 'Synthetic beta\\s*1', 'Synthetic overdue goal', 'Synthetic daily goal', 'Synthetic new v2'])
  await expect(number).toHaveText('0')
  await page.keyboard.type('9')
  await expectRows(page, ['Synthetic new v2\\s*9', 'Synthetic alpha\\s*3', 'Synthetic beta\\s*1', 'Synthetic overdue goal', 'Synthetic daily goal'])

  // Clicking a row's words edits them in place.
  await rows(page).nth(2).locator('.priority-text').click()
  const edit = page.getByRole('textbox', { name: 'Priority text' })
  await expect(edit).toBeFocused()
  await page.keyboard.type(' renamed')
  await page.keyboard.press('Enter')
  await expect(number).toBeFocused()
  await expect(rows(page).nth(2)).toHaveText(/^\s*3\s*Synthetic beta renamed\s*1\s*$/)
  await rows(page).nth(3).locator('.priority-text').click()
  await page.keyboard.type(' x')
  await page.locator('.prioritize-add').click()
  await expect(rows(page).nth(3)).toHaveText(/Synthetic overdue goal x\s*$/)
  await expect(page.getByText('Overdue only')).toHaveCount(0)

  // Cmd/Ctrl+E edits the selected row; Escape saves like Enter.
  await rows(page).nth(2).locator('.priority-rank').click()
  await page.keyboard.press('ControlOrMeta+e')
  await expect(edit).toBeFocused()
  await expect(edit).toHaveValue('Synthetic beta renamed')
  await page.keyboard.type(' too')
  await page.keyboard.press('Escape')
  await expect(number).toBeFocused()
  await expect(rows(page).nth(2)).toHaveText(/Synthetic beta renamed too\s*1\s*$/)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(rows(page).nth(2)).toHaveText(/Synthetic beta renamed\s*1\s*$/)

  // Arrow keys wrap around the ends of the list.
  await rows(page).first().locator('.priority-rank').click()
  await page.keyboard.press('ArrowUp')
  await expect(rows(page).last()).toHaveClass(/selected/)
  await page.keyboard.press('ArrowDown')
  await expect(rows(page).first()).toHaveClass(/selected/)

  // The selected row's x or Cmd/Ctrl+D deletes it; selection takes its place.
  await page.keyboard.press('ArrowDown')
  await expect(rows(page).nth(1).getByRole('button', { name: /^Delete / })).toBeVisible()
  await expect(page.getByRole('button', { name: /^Delete / })).toHaveCount(1)
  await page.keyboard.press('ControlOrMeta+d')
  await expect(rows(page)).toHaveCount(4)
  await expect(rows(page).nth(1)).toHaveText(/Synthetic beta renamed/)
  await expect(rows(page).nth(1)).toHaveClass(/selected/)
  await rows(page).nth(1).getByRole('button', { name: 'Delete Synthetic beta renamed' }).click()
  await expect(rows(page)).toHaveCount(3)
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+z')
  await expect(rows(page)).toHaveCount(5)
  await expect(rows(page).nth(1)).toHaveText(/Synthetic alpha\s*3\s*$/)

  // Long priorities wrap instead of truncating, also while editing.
  const long = 'Synthetic long priority '.repeat(8).trim()
  await page.locator('.prioritize-add').fill(long)
  await page.locator('.prioritize-add').press('Enter')
  const longRow = rows(page).last()
  await expect(longRow).toHaveText(new RegExp(`${long}\\s*$`))
  expect((await longRow.boundingBox())!.height).toBeGreaterThan(50)
  await longRow.locator('.priority-text').click()
  const editor = page.getByRole('textbox', { name: 'Priority text' })
  expect(await editor.evaluate((field) => field.scrollHeight <= field.clientHeight + 1 && field.clientHeight > 40)).toBe(true)
  await page.keyboard.press('Escape')
  await expect(number).toBeFocused()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(rows(page)).toHaveCount(5)

  // IMAX hides the sidebar but keeps Back and the exit control beside it.
  await page.keyboard.press('Alt+KeyI')
  await expect(page.locator('.app-shell.page-maximized')).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Back' })).toBeVisible()
  await expect(page.locator('.imax-exit-control')).toHaveCount(0)
  await page.getByRole('button', { name: 'Exit IMAX mode' }).click()
  await expect(page.locator('.app-shell.page-maximized')).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Enter IMAX mode' })).toBeVisible()

  // Undo restores the last lasting edit time too.
  await page.clock.fastForward(5 * 60_000)
  const [before] = await sessions(page)
  await rows(page).nth(4).locator('.priority-rank').click()
  await page.keyboard.type('7')
  const [edited] = await sessions(page)
  expect(edited.updatedAt).not.toBe(before.updatedAt)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await sessions(page))[0]).toEqual(before)
  await expect(rows(page).nth(4)).toHaveText(/Synthetic daily goal\s*$/)

  // Simply viewing a session after the idle timeout returns to the start.
  await openView(page, 'Projects')
  await page.clock.fastForward(31 * 60_000)
  await openView(page, 'Prioritize')
  await expect(page.getByRole('button', { name: 'Start prioritizing' })).toBeVisible()
  await page.getByRole('button', { name: 'Past sessions' }).click()
  const past = page.locator('.prioritize-past button')
  await expect(past).toHaveCount(1)
  await expect(past.locator('strong')).toHaveText('Sep 9, 11:00 AM')
  await expect(past.locator('.prioritize-past-edited')).toHaveText('Last edited: Sep 9, 11:00 AM')
  await expect(past.locator('.prioritize-past-row')).toHaveCount(5)
  await expect(past.locator('.prioritize-past-row').first()).toHaveText(/Synthetic new v2\s*9/)
  await past.click()
  await expect(rows(page)).toHaveCount(5)
  expect(await sessions(page)).toEqual([before])
})

test('touch prioritizing uses tapped rows and a next button', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Keyboard entry is covered on desktop')
  await seed(page)
  await openView(page, 'Prioritize')
  await page.getByRole('button', { name: 'Start prioritizing' }).click()
  await expect(rows(page)).toHaveCount(4)

  const number = page.locator('.prioritize-number-proxy')
  await rows(page).nth(1).locator('.priority-rank').tap()
  await expect(number).toBeFocused()
  await page.keyboard.type('4')
  await expect(rows(page).first()).toHaveText(/Synthetic beta\s*4\s*$/)
  await expect(page.locator('.prioritize-number h3')).toHaveText('4')
  await page.getByRole('button', { name: 'Next unrated' }).tap()
  await expect(rows(page).nth(1)).toHaveClass(/selected/)
  await expect(number).toBeFocused()

  const add = page.getByRole('textbox', { name: 'Add priority' })
  await add.tap()
  await add.fill('Synthetic phone item')
  await add.press('Enter')
  await expect(number).toBeFocused()
  await expect(rows(page).last()).toHaveText(/Synthetic phone item\s*$/)

  // The entry bar stays on screen while the list scrolls under it.
  const bar = page.locator('.prioritize-entry')
  const box = await bar.boundingBox()
  const viewport = page.viewportSize()!
  expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height + 1)
})
