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
  await expect(rows(page)).toHaveText(expected.map((text, index) => new RegExp(`^${index + 1}\\s*${text}\\s*$`)))
}

test('keyboard prioritizing reorders, persists, undoes and times out', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Touch entry is covered separately')
  await seed(page)
  await openView(page, 'Prioritize')
  await expect(page.getByRole('button', { name: 'Past sessions' })).toHaveCount(0)
  await page.getByRole('button', { name: 'Start prioritizing' }).click()

  const add = page.getByRole('textbox', { name: 'Add priority' })
  const number = page.locator('.prioritize-number')
  await expectRows(page, ['Synthetic alpha', 'Synthetic beta', 'Synthetic overdue goal', 'Synthetic daily goal', 'Synthetic monthly goal'])
  await expect(number).toBeFocused()

  await page.keyboard.type('3')
  await page.keyboard.press('Enter')
  await page.keyboard.type('12')
  await expectRows(page, ['Synthetic beta\\s*12', 'Synthetic alpha\\s*3', 'Synthetic overdue goal', 'Synthetic daily goal', 'Synthetic monthly goal'])
  await expect(rows(page).first()).toHaveClass(/selected/)

  // Backspace edits the selected value; Enter skips to the next unrated row.
  await page.keyboard.press('Backspace')
  await expectRows(page, ['Synthetic alpha\\s*3', 'Synthetic beta\\s*1', 'Synthetic overdue goal', 'Synthetic daily goal', 'Synthetic monthly goal'])
  await page.keyboard.press('Enter')
  await expect(rows(page).nth(2)).toHaveClass(/selected/)
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('ArrowUp')
  await expect(rows(page).nth(3)).toHaveClass(/selected/)

  // Letters go to the add field; Enter adds, selects, and returns to the number.
  await page.keyboard.type('Synthetic new')
  await expect(add).toBeFocused()
  await expect(add).toHaveValue('Synthetic new')
  await page.keyboard.press('Enter')
  await expect(add).toHaveValue('')
  await expect(number).toBeFocused()
  await expect(rows(page).last()).toHaveText(/Synthetic new\s*$/)
  await expect(rows(page).last()).toHaveClass(/selected/)
  await page.keyboard.type('2')
  await expectRows(page, ['Synthetic alpha\\s*3', 'Synthetic new\\s*2', 'Synthetic beta\\s*1', 'Synthetic overdue goal', 'Synthetic daily goal', 'Synthetic monthly goal'])

  // Tab switches fields; a digit from an empty add field goes to the number.
  await page.keyboard.press('Tab')
  await expect(add).toBeFocused()
  await page.keyboard.press('ArrowUp')
  await page.keyboard.type('9')
  await expect(number).toBeFocused()
  await expectRows(page, ['Synthetic alpha\\s*9', 'Synthetic new\\s*2', 'Synthetic beta\\s*1', 'Synthetic overdue goal', 'Synthetic daily goal', 'Synthetic monthly goal'])

  // Undo restores the last lasting edit time too.
  await page.clock.fastForward(5 * 60_000)
  const [before] = await sessions(page)
  await rows(page).nth(4).click()
  await page.keyboard.type('7')
  const [edited] = await sessions(page)
  expect(edited.updatedAt).not.toBe(before.updatedAt)
  await page.keyboard.press('ControlOrMeta+z')
  await expect.poll(async () => (await sessions(page))[0]).toEqual(before)
  await expect(page.locator('.prioritize-panel .page-header h2')).toHaveText('Prioritize')

  // Simply viewing a session after the idle timeout returns to the start.
  await openView(page, 'Projects')
  await page.clock.fastForward(31 * 60_000)
  await openView(page, 'Prioritize')
  await expect(page.getByRole('button', { name: 'Start prioritizing' })).toBeVisible()
  await page.getByRole('button', { name: 'Past sessions' }).click()
  const past = page.locator('.prioritize-past button')
  await expect(past).toHaveCount(1)
  await expect(past).toContainText('Sep 9, 11:00 AM')
  await past.click()
  await expect(rows(page)).toHaveCount(6)
  expect(await sessions(page)).toEqual([before])
})

test('touch prioritizing uses tapped rows and a next button', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Keyboard entry is covered on desktop')
  await seed(page)
  await openView(page, 'Prioritize')
  await page.getByRole('button', { name: 'Start prioritizing' }).click()
  await expect(rows(page)).toHaveCount(5)

  const number = page.locator('.prioritize-number')
  await rows(page).nth(1).tap()
  await expect(number).toBeFocused()
  await page.keyboard.type('4')
  await expect(rows(page).first()).toHaveText(/Synthetic beta\s*4\s*$/)
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
