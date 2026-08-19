import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { COMPLETION_CELEBRATIONS } from '../../src/lib/celebrations'

const REMINDER = 'REMINDER: YOU MIGHT WANT TO PICK YOUR FAVS AND JUST HAVE IT ASSIGN ONE AT RANDOM TO EACH DAY AND PLAY THAT AFTER THE DAY IS OVER, AND DELETE THE OTHERS AND THIS SETTINGS SECTION'

function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number)
  const shifted = new Date(year, month - 1, day + days)
  return [
    shifted.getFullYear(),
    String(shifted.getMonth() + 1).padStart(2, '0'),
    String(shifted.getDate()).padStart(2, '0'),
  ].join('-')
}

async function resetBrowserState(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.locator('.today-date-input')).toBeVisible()
}

async function openSettings(page: Page, testInfo: TestInfo) {
  if (testInfo.project.name === 'mobile') {
    await page.getByRole('button', { name: 'Open navigation' }).click()
  }
  await page.getByRole('complementary').getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
}

async function storedNavigationAndPlans(page: Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') ?? 'null')
    return {
      activePlanDate: state?.activePlanDate,
      plans: state?.plans,
    }
  })
}

test('Settings renders exactly 30 named celebration cards with copy, icons, and the exact reminder', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  await openSettings(page, testInfo)

  const picker = page.getByRole('group', { name: 'Day completion celebration' })
  const options = picker.locator('.celebration-option')
  const cards = picker.locator('.celebration-option-button')
  await expect(options).toHaveCount(30)
  await expect(cards).toHaveCount(30)
  await expect(picker.locator('.celebration-option-art')).toHaveCount(30)

  const renderedCatalog = await cards.evaluateAll((buttons) => buttons.map((button) => ({
    id: button.getAttribute('data-celebration-option'),
    name: button.querySelector('.celebration-option-copy strong')?.textContent?.trim(),
    description: button.querySelector('.celebration-option-copy small')?.textContent?.trim(),
    icon: button.querySelector('.celebration-option-icon')?.textContent?.trim(),
  })))
  expect(renderedCatalog).toEqual(COMPLETION_CELEBRATIONS.map(({ id, name, description, icon }) => ({
    id,
    name,
    description,
    icon,
  })))

  const reminder = page.getByRole('heading', { name: REMINDER, exact: true })
  await expect(reminder).toBeVisible()
  await expect(reminder).toHaveText(REMINDER)
  await expect(reminder).toHaveJSProperty('tagName', 'H4')
  await expect(reminder.locator('xpath=..').locator(':scope > :last-child')).toHaveText(REMINDER)
})

test('selecting saves, previews yesterday without mutating navigation or plans, and Return now restores Settings', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  const initialDate = await page.locator('.today-date-input').inputValue()
  const before = await storedNavigationAndPlans(page)
  await openSettings(page, testInfo)

  const picker = page.getByRole('group', { name: 'Day completion celebration' })
  const deadlineGoose = picker.locator('[data-celebration-option="deadline-goose"]')
  await deadlineGoose.scrollIntoViewIfNeeded()
  const settingsScrollTop = await page.evaluate((mobile) =>
    mobile ? window.scrollY : (document.querySelector<HTMLElement>('.workspace')?.scrollTop ?? 0),
  testInfo.project.name === 'mobile')
  await deadlineGoose.click()

  const previewControl = page.locator('.celebration-preview-control')
  await expect(previewControl).toContainText('Previewing Deadline Goose on yesterday')
  const returnButton = page.getByRole('button', { name: 'Return now' })
  await expect(returnButton).toBeFocused()
  expect(await page.evaluate(() => {
    const shell = document.querySelector('.app-shell')
    const stage = document.querySelector('.celebration-stage')
    const canvas = document.querySelector('.celebration-canvas')
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') ?? 'null')
    return {
      shellInert: shell?.hasAttribute('inert'),
      shellAriaHidden: shell?.getAttribute('aria-hidden'),
      displayedDate: (document.querySelector('.today-date-input') as HTMLInputElement | null)?.value,
      stageId: stage?.getAttribute('data-celebration-id'),
      stageEngine: stage?.getAttribute('data-celebration-engine'),
      stageRecipe: stage?.getAttribute('data-celebration-recipe'),
      canvasId: canvas?.getAttribute('data-celebration-id'),
      canvasEngine: canvas?.getAttribute('data-celebration-engine'),
      activePlanDate: state?.activePlanDate,
      plans: state?.plans,
    }
  })).toEqual({
    shellInert: true,
    shellAriaHidden: 'true',
    displayedDate: addDays(initialDate, -1),
    stageId: 'deadline-goose',
    stageEngine: 'character',
    stageRecipe: 'goose',
    canvasId: 'deadline-goose',
    canvasEngine: 'character',
    ...before,
  })

  await returnButton.press('Enter')
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(deadlineGoose).toHaveAttribute('aria-pressed', 'true')
  await expect(deadlineGoose).toBeFocused()
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '')
  await expect.poll(() => page.evaluate(({ mobile, settingsScrollTop }) => {
    const restoredScrollTop = mobile
      ? window.scrollY
      : (document.querySelector<HTMLElement>('.workspace')?.scrollTop ?? 0)
    return Math.abs(restoredScrollTop - settingsScrollTop)
  }, { mobile: testInfo.project.name === 'mobile', settingsScrollTop })).toBeLessThanOrEqual(2)
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') ?? 'null')
    return state?.preferences?.completionCelebrationId
  })).toBe('deadline-goose')
  await expect.poll(() => storedNavigationAndPlans(page)).toEqual(before)

  await page.reload()
  await openSettings(page, testInfo)
  await expect(page.locator('[data-celebration-option="deadline-goose"]')).toHaveAttribute('aria-pressed', 'true')
})

test('reduced motion draws no canvas frames and automatic return restores Settings and focus', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await resetBrowserState(page)
  const before = await storedNavigationAndPlans(page)
  await openSettings(page, testInfo)

  const option = page.locator('[data-celebration-option="event-horizon"]')
  await option.scrollIntoViewIfNeeded()
  await option.click()

  await expect(page.locator('.celebration-stage')).toHaveClass(/reduced/)
  await expect(page.locator('.celebration-stage')).toHaveAttribute('data-celebration-id', 'event-horizon')
  const canvasSnapshot = async () => page.locator('.celebration-canvas').evaluate((canvas: HTMLCanvasElement) => {
    const context = canvas.getContext('2d')
    const pixels = context?.getImageData(0, 0, canvas.width, canvas.height).data ?? []
    return {
      width: canvas.width,
      height: canvas.height,
      hasPaintedPixel: Array.from(pixels).some((channel) => channel !== 0),
    }
  })
  const firstCanvas = await canvasSnapshot()
  await page.waitForTimeout(250)
  expect(await canvasSnapshot()).toEqual(firstCanvas)
  expect(firstCanvas.hasPaintedPixel).toBe(false)

  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible({ timeout: 3_500 })
  await expect(page.locator('.celebration-preview-control')).toHaveCount(0)
  await expect(option).toBeFocused()
  await expect(option).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => storedNavigationAndPlans(page)).toEqual(before)
})

test('every catalog entry launches its own stable hooks and fully cleans up', async ({ page }, testInfo) => {
  test.setTimeout(120_000)
  test.skip(testInfo.project.name !== 'desktop', 'The complete catalog sweep only needs one browser profile.')
  await resetBrowserState(page)
  await openSettings(page, testInfo)

  for (const celebration of COMPLETION_CELEBRATIONS) {
    const option = page.locator(`[data-celebration-option="${celebration.id}"]`)
    await option.scrollIntoViewIfNeeded()
    await option.click()
    const stage = page.locator('.celebration-stage')
    await expect(stage).toHaveAttribute('data-celebration-id', celebration.id)
    await expect(stage).toHaveAttribute('data-celebration-engine', celebration.engine)
    await expect(stage).toHaveAttribute('data-celebration-recipe', celebration.recipe)
    await expect(page.locator('.celebration-canvas')).toHaveAttribute('data-celebration-id', celebration.id)
    await expect(page.locator('html')).toHaveAttribute('data-celebration-id', celebration.id)

    await page.getByRole('button', { name: 'Return now' }).click()
    await expect(stage).toHaveCount(0)
    await expect(page.locator('.celebration-canvas')).not.toHaveAttribute('data-celebration-id', /.+/)
    await expect(page.locator('html')).not.toHaveAttribute('data-celebration-id', /.+/)
  }
})

test('celebration picker arrows rove without saving or previewing until activation', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  await openSettings(page, testInfo)

  const picker = page.getByRole('group', { name: 'Day completion celebration' })
  const first = picker.locator('[data-celebration-option="aurora-checkwave"]')
  const second = picker.locator('[data-celebration-option="dandelion-done"]')
  await first.focus()
  await first.press('ArrowRight')
  await expect(second).toBeFocused()
  await expect(page.locator('.celebration-preview-control')).toHaveCount(0)
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(second).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.celebration-option-button[tabindex="0"]')).toHaveCount(1)
})
