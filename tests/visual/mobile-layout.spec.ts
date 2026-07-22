import { expect, test } from '@playwright/test'

const isMobileProject = (projectName: string) => projectName === 'mobile'

test.beforeEach(async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => {
    const date = new Date().toISOString().slice(0, 10)
    const item = (
      id: string,
      text: string,
      depthChildren: ReturnType<typeof item>[] = [],
      startMinutes: number | null = null,
      endMinutes: number | null = null,
    ) => ({ id, text, html: text, done: false, startMinutes, endMinutes, children: depthChildren })

    const deepest = item(
      'deepest',
      'Deeply nested task text should still have enough room to be comfortably readable',
      [],
      690,
      750,
    )
    const nested = item('nested', 'Nested task without a time', [deepest])
    const parent = item('parent', 'Parent task with a scheduled time', [nested], 600, 660)
    const trailing = item('trailing', 'Another task used to verify mobile drag selection')
    const filler = Array.from({ length: 28 }, (_, index) => item(`filler_${index}`, `Filler task ${index + 1}`))
    const listItems = Array.from({ length: 12 }, (_, index) => item(`list_${index}`, `Groceries item ${index + 1}`))

    localStorage.clear()
    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'mobile-layout-test',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: date,
        templates: [],
        plans: [
          {
            id: 'plan_mobile',
            date,
            dailyReminder: '',
            items: [parent, trailing, ...filler, item('opener', 'Groceries')],
          },
        ],
        listTemplates: [
          {
            id: 'groceries_template',
            name: 'Groceries',
            maxExpectedWords: 100,
            items: listItems.map((listItem) => ({ ...listItem, probability: 100 })),
          },
        ],
        lists: [
          {
            id: 'groceries_list',
            listTemplateId: 'groceries_template',
            date,
            items: listItems,
          },
        ],
        metrics: [],
        metricEntries: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  })
  await page.reload()
  await expect(page.getByRole('listitem', { name: 'Plan item: Parent task with a scheduled time' })).toBeVisible()
})

test('task rows stay readable on mobile without changing the desktop arrangement', async ({ page }, testInfo) => {
  const row = page.getByRole('listitem', {
    name: 'Plan item: Deeply nested task text should still have enough room to be comfortably readable',
  })
  const text = row.locator('[data-plan-text-input]')
  const time = row.getByLabel('Time range')
  const undo = page.getByRole('button', { name: 'Undo' })

  const geometry = await row.evaluate((element) => {
    const textElement = element.querySelector<HTMLElement>('[data-plan-text-input]')
    const timeElement = element.querySelector<HTMLElement>('.time-range')
    if (!textElement || !timeElement) throw new Error('Missing task row content')
    const textRect = textElement.getBoundingClientRect()
    const timeRect = timeElement.getBoundingClientRect()
    return {
      textWidth: textRect.width,
      textTop: textRect.top,
      timeTop: timeRect.top,
      timeRight: timeRect.right,
      textLeft: textRect.left,
    }
  })

  if (isMobileProject(testInfo.project.name)) {
    expect(geometry.textWidth).toBeGreaterThanOrEqual(190)
    expect(geometry.timeTop).toBeGreaterThan(geometry.textTop)
    await expect(undo).toBeVisible()

    const checkbox = page
      .getByRole('listitem', { name: 'Plan item: Parent task with a scheduled time' })
      .getByRole('checkbox')
    await checkbox.check()
    await undo.click()
    await expect(checkbox).not.toBeChecked()

    await dragAcross(
      page,
      page.getByRole('listitem', { name: 'Plan item: Parent task with a scheduled time' }).locator('[data-plan-text-input]'),
      page.getByRole('listitem', { name: 'Plan item: Another task used to verify mobile drag selection' }).locator('[data-plan-text-input]'),
    )
    await expect(page.locator('.plan-row.selected')).toHaveCount(0)
  } else {
    expect(geometry.timeRight).toBeLessThanOrEqual(geometry.textLeft)
    await expect(undo).toBeHidden()
  }

  await expect(text).toBeVisible()
  await expect(time).toBeVisible()
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-task-layout.png`,
    fullPage: false,
  })
})

test('the list modal stays centered in the mobile viewport on a long day', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The regression only affects document-scrolling mobile layouts')

  const opener = page.getByRole('link', { name: 'Groceries' })
  await opener.scrollIntoViewIfNeeded()
  await opener.click()

  const dialog = page.getByRole('dialog', { name: 'Groceries' })
  await expect(dialog).toBeVisible()
  const centering = await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    const backdrop = element.parentElement
    return {
      dialogCenter: rect.top + rect.height / 2,
      viewportCenter: window.innerHeight / 2,
      backdropPosition: backdrop ? getComputedStyle(backdrop).position : '',
    }
  })

  expect(centering.backdropPosition).toBe('fixed')
  expect(Math.abs(centering.dialogCenter - centering.viewportCenter)).toBeLessThan(24)
  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-list-modal-centered.png',
    fullPage: false,
  })
})

test('deeply indented task text remains usable at the minimum supported width', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The minimum-width layout is mobile-only')
  await page.setViewportSize({ width: 320, height: 700 })

  const row = page.getByRole('listitem', {
    name: 'Plan item: Deeply nested task text should still have enough room to be comfortably readable',
  })
  const textWidth = await row.locator('[data-plan-text-input]').evaluate(
    (element) => element.getBoundingClientRect().width,
  )

  expect(textWidth).toBeGreaterThanOrEqual(170)
  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-320-task-layout.png',
    fullPage: false,
  })
})

async function dragAcross(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
) {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Missing drag geometry')

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 })
  await page.mouse.up()
}
