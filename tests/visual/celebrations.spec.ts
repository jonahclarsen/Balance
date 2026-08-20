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

test('Settings renders every named celebration card with copy, icons, and the exact reminder', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  await openSettings(page, testInfo)

  const picker = page.getByRole('group', { name: 'Day completion celebration' })
  const options = picker.locator('.celebration-option')
  const cards = picker.locator('.celebration-option-button')
  await expect(options).toHaveCount(COMPLETION_CELEBRATIONS.length)
  await expect(cards).toHaveCount(COMPLETION_CELEBRATIONS.length)
  await expect(picker.locator('.celebration-option-art')).toHaveCount(COMPLETION_CELEBRATIONS.length)

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

test('keyboard celebration review marks choices, browses, and copies only removals', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })
  const initialDate = await page.locator('.today-date-input').inputValue()
  const before = await storedNavigationAndPlans(page)
  await openSettings(page, testInfo)

  const start = page.getByRole('button', { name: 'Review all with Y / N' })
  await start.click()

  const review = page.getByRole('dialog', { name: 'Celebration review' })
  await expect(review).toBeVisible()
  await expect(review).toContainText(`1 / ${COMPLETION_CELEBRATIONS.length}`)
  await expect(review).toContainText('Aurora Checkwave')
  await expect(review).toContainText('UNDECIDED')
  await expect(page.locator('.app-shell')).toHaveAttribute('inert', '')
  await expect(page.locator('.today-date-input')).toHaveValue(addDays(initialDate, -1))
  await expect(page.locator('.celebration-stage')).toHaveAttribute('data-celebration-id', 'aurora-checkwave')

  await page.keyboard.press('n')
  await expect(review).toContainText('Dandelion Done')
  await expect(page.locator('.celebration-stage')).toHaveAttribute('data-celebration-id', 'dandelion-done')
  await page.keyboard.press('y')
  await expect(review).toContainText('Constellation Closure')
  await page.keyboard.press('ArrowRight')
  await expect(review).toContainText('Bioluminescent Tide')
  await page.keyboard.press('ArrowLeft')
  await expect(review).toContainText('Constellation Closure')
  await page.keyboard.press('n')
  await expect(review).toContainText('Bioluminescent Tide')

  await page.keyboard.press('c')
  await expect(review.getByRole('status')).toHaveText('Copied 2 removals.')
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
    'Aurora Checkwave',
    'Constellation Closure',
  ].join('\n'))

  await page.keyboard.press('Escape')
  await expect(review).toHaveCount(0)
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await expect(start).toBeFocused()
  await expect(page.locator('.app-shell')).not.toHaveAttribute('inert', '')
  await expect(page.locator('[data-celebration-option="aurora-checkwave"]')).toHaveAttribute('aria-pressed', 'true')
  await expect.poll(() => storedNavigationAndPlans(page)).toEqual(before)
})

test('selecting saves, previews yesterday without chrome or plan mutations, and Escape restores Settings', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  const initialDate = await page.locator('.today-date-input').inputValue()
  const before = await storedNavigationAndPlans(page)
  await openSettings(page, testInfo)

  const picker = page.getByRole('group', { name: 'Day completion celebration' })
  const deadlineGoose = picker.locator('[data-celebration-option="deadline-goose"]')
  await deadlineGoose.evaluate((element) => element.scrollIntoView({ block: 'center', inline: 'nearest' }))
  await expect(deadlineGoose).toBeVisible()
  const settingsScrollTop = await page.evaluate((mobile) =>
    mobile ? window.scrollY : (document.querySelector<HTMLElement>('.workspace')?.scrollTop ?? 0),
  testInfo.project.name === 'mobile')
  await deadlineGoose.click()

  await expect(page.locator('.celebration-preview-control')).toHaveCount(0)
  await expect(page.locator('.celebration-banner')).toHaveCount(0)
  await expect(page.locator('.celebration-announcement')).toHaveCount(1)
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
      activeElement: document.activeElement?.tagName,
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
    activeElement: 'BODY',
    ...before,
  })

  await page.keyboard.press('Escape')
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

test('Tiny Janitor renders an articulated sweeping character without a signature pill', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  await openSettings(page, testInfo)

  const option = page.locator('[data-celebration-option="tiny-janitor"]')
  await option.scrollIntoViewIfNeeded()
  await option.click()

  const stage = page.locator('.celebration-stage[data-celebration-id="tiny-janitor"]')
  await expect(stage).toBeVisible()
  expect(await stage.evaluate((root) => {
    const broom = root.querySelector('.janitor-broom')
    if (!broom) return null
    const animation = getComputedStyle(broom).animation
    return {
      janitorCount: root.querySelectorAll('svg.janitor').length,
      personCount: root.querySelectorAll('.janitor-person').length,
      armCount: root.querySelectorAll('.janitor-front-arm, .janitor-rear-arm').length,
      legCount: root.querySelectorAll('.janitor-front-leg, .janitor-back-leg').length,
      mirroredLegCount: root.querySelectorAll('.janitor-front-leg-art').length,
      broomCount: root.querySelectorAll('.janitor-broom').length,
      gripCount: broom.querySelectorAll('.janitor-hand').length,
      allClearCount: root.querySelectorAll('.janitor-all-clear').length,
      signatureCount: document.querySelectorAll('.effect-signature').length,
      duration: getComputedStyle(broom).animationDuration,
      iterationCount: getComputedStyle(broom).animationIterationCount,
      hasPerformanceTimeline: animation.includes('broom-performance'),
    }
  })).toEqual({
    janitorCount: 1,
    personCount: 1,
    armCount: 2,
    legCount: 2,
    mirroredLegCount: 1,
    broomCount: 1,
    gripCount: 2,
    allClearCount: 1,
    signatureCount: 0,
    duration: '5s',
    iterationCount: '1',
    hasPerformanceTimeline: true,
  })
})

test('mindful celebrations render their distinct presence, metta, and enough scenes', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  await openSettings(page, testInfo)

  const recipes = [
    {
      id: 'bell-of-now',
      selector: '.presence-bell',
      copy: ['HERE · NOW'],
    },
    {
      id: 'loving-kindness-ripple',
      selector: '.metta-heart',
      copy: ['May I be well', 'May you be well', 'May all be well'],
    },
    {
      id: 'enough-for-today',
      selector: '.enough-candle',
      copy: ['this day was lived', 'and it is enough'],
    },
  ] as const

  for (const recipe of recipes) {
    const option = page.locator(`[data-celebration-option="${recipe.id}"]`)
    await option.scrollIntoViewIfNeeded()
    await option.click()

    const stage = page.locator(`.celebration-stage[data-celebration-id="${recipe.id}"]`)
    await expect(stage.locator(recipe.selector)).toHaveCount(1)
    for (const copy of recipe.copy) await expect(stage).toContainText(copy)

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  }
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

    await page.keyboard.press('Escape')
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
