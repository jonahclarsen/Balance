import { expect, test, type Page, type TestInfo } from '@playwright/test'
import { COMPLETION_CELEBRATIONS, COMPLETION_CELEBRATION_OPTIONS } from '../../src/lib/celebrations'

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

test('Settings renders Random first followed by every celebration card', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  await openSettings(page, testInfo)

  const picker = page.getByRole('group', { name: 'Day completion celebration' })
  const options = picker.locator('.celebration-option')
  const cards = picker.locator('.celebration-option-button')
  await expect(options).toHaveCount(COMPLETION_CELEBRATION_OPTIONS.length)
  await expect(cards).toHaveCount(COMPLETION_CELEBRATION_OPTIONS.length)
  await expect(picker.locator('.celebration-option-art')).toHaveCount(COMPLETION_CELEBRATION_OPTIONS.length)

  const renderedCatalog = await cards.evaluateAll((buttons) => buttons.map((button) => ({
    id: button.getAttribute('data-celebration-option'),
    name: button.querySelector('.celebration-option-copy strong')?.textContent?.trim(),
    description: button.querySelector('.celebration-option-copy small')?.textContent?.trim(),
    icon: button.querySelector('.celebration-option-icon')?.textContent?.trim(),
  })))
  expect(renderedCatalog).toEqual(COMPLETION_CELEBRATION_OPTIONS.map(({ id, name, description, icon }) => ({
    id,
    name,
    description,
    icon,
  })))

  await expect(cards.first()).toHaveAttribute('data-celebration-option', 'random')
  await expect(cards.first()).toHaveAttribute('aria-pressed', 'true')
  await expect(page.locator('.celebration-settings > .settings-actions')).toHaveCount(0)
})

test('Random persists as the preference and previews a concrete celebration', async ({ page }, testInfo) => {
  await resetBrowserState(page)
  await openSettings(page, testInfo)

  const random = page.locator('[data-celebration-option="random"]')
  await random.click()

  const stageId = await page.locator('.celebration-stage').getAttribute('data-celebration-id')
  expect(COMPLETION_CELEBRATIONS.map(({ id }) => id)).toContain(stageId)
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') ?? 'null')
    return state?.preferences?.completionCelebrationId
  })).toBe('random')

  await page.keyboard.press('Escape')
  await expect(random).toHaveAttribute('aria-pressed', 'true')
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
      copy: ['YOU ARE HERE + NOW'],
      parts: ['.presence-bell-casting', '.presence-bell-mouth', '.presence-bell-clapper'],
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
    if ('parts' in recipe) {
      for (const part of recipe.parts) await expect(stage.locator(part)).toHaveCount(1)
    }

    await page.keyboard.press('Escape')
    await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  }
})

test('reduced motion draws no canvas frames and automatic return restores Settings and focus', async ({ page }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await resetBrowserState(page)
  const before = await storedNavigationAndPlans(page)
  await openSettings(page, testInfo)

  const option = page.locator('[data-celebration-option="infinite-feedback-cathedral"]')
  await option.scrollIntoViewIfNeeded()
  await option.click()

  await expect(page.locator('.celebration-stage')).toHaveClass(/reduced/)
  await expect(page.locator('.celebration-stage')).toHaveAttribute('data-celebration-id', 'infinite-feedback-cathedral')
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
  const first = picker.locator('[data-celebration-option="random"]')
  const second = picker.locator('[data-celebration-option="stained-glass-sunrise"]')
  await first.focus()
  await first.press('ArrowRight')
  await expect(second).toBeFocused()
  await expect(page.locator('.celebration-preview-control')).toHaveCount(0)
  await expect(first).toHaveAttribute('aria-pressed', 'true')
  await expect(second).toHaveAttribute('aria-pressed', 'false')
  await expect(page.locator('.celebration-option-button[tabindex="0"]')).toHaveCount(1)
})
