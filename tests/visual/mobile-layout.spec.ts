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
        templates: [
          {
            id: 'day_template_mobile',
            name: 'Mobile day',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            items: [
              {
                id: 'day_template_item',
                startMinutes: 600,
                endMinutes: 660,
                options: [
                  {
                    id: 'day_option_one',
                    text: 'A comfortably long first option',
                    html: 'A comfortably long first option',
                    probability: 50,
                  },
                  {
                    id: 'day_option_two',
                    text: 'Another possible activity',
                    html: 'Another possible activity',
                    probability: 50,
                  },
                ],
                children: [],
              },
            ],
          },
        ],
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
  const time = isMobileProject(testInfo.project.name)
    ? row.getByRole('button', { name: 'Edit time 11:30am to 12:30pm' })
    : row.getByLabel('Time range')
  const geometry = await row.evaluate((element) => {
    const textElement = element.querySelector<HTMLElement>('[data-plan-text-input]')
    const timeElement = element.querySelector<HTMLElement>('.time-range, .mobile-time-summary')
    if (!textElement || !timeElement) throw new Error('Missing task row content')
    const textRect = textElement.getBoundingClientRect()
    const timeRect = timeElement.getBoundingClientRect()
    const mainElement = element.querySelector<HTMLElement>('.plan-item-main')
    const textRange = document.createRange()
    textRange.selectNodeContents(textElement)
    const firstTextRect = textRange.getClientRects()[0]
    const mainRect = mainElement?.getBoundingClientRect()
    return {
      textWidth: textRect.width,
      textTop: textRect.top,
      timeTop: timeRect.top,
      timeLeft: timeRect.left,
      timeRight: timeRect.right,
      textLeft: textRect.left,
      taskTextLeft: firstTextRect?.left ?? null,
      timeSpaceAbove: mainRect ? timeRect.top - mainRect.top : null,
      timeSpaceBelow: firstTextRect ? firstTextRect.top - timeRect.bottom : null,
    }
  })

  if (isMobileProject(testInfo.project.name)) {
    expect(geometry.textWidth).toBeGreaterThanOrEqual(190)
    expect(geometry.timeTop).toBeLessThan(geometry.textTop)
    expect(Math.abs((geometry.taskTextLeft ?? 0) - geometry.timeLeft)).toBeLessThanOrEqual(1)
    expect(Math.abs((geometry.timeSpaceAbove ?? 0) - (geometry.timeSpaceBelow ?? 0))).toBeLessThanOrEqual(4)
    await expect(time).toHaveClass(/warning-end/)
    await expect(time).not.toHaveClass(/warning-start/)
    const timeColors = await time.evaluate((element) => {
      const probe = document.createElement('span')
      element.appendChild(probe)
      probe.style.backgroundColor = 'var(--time-bg)'
      const normal = getComputedStyle(probe).backgroundColor
      probe.style.backgroundColor = 'var(--time-warn-bg)'
      const warning = getComputedStyle(probe).backgroundColor
      probe.remove()
      return {
        normal,
        warning,
        start: getComputedStyle(element.querySelector('.mobile-time-start-side')!).backgroundColor,
        end: getComputedStyle(element.querySelector('.mobile-time-end-side')!).backgroundColor,
      }
    })
    expect(timeColors.start).toBe(timeColors.normal)
    expect(timeColors.end).toBe(timeColors.warning)
    await expect(row.locator('.select-handle')).toHaveCount(0)
    await expect(row.getByRole('button', { name: 'Task options for Deeply nested task text should still have enough room to be comfortably readable' })).toBeVisible()

    const checkbox = page
      .getByRole('listitem', { name: 'Plan item: Parent task with a scheduled time' })
      .getByRole('checkbox')
    await checkbox.check()
    const undo = page.locator('.mobile-app-header').getByRole('button', { name: 'Undo' })
    await expect(undo).toBeVisible()
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
    await expect(row.locator('.select-handle')).toBeVisible()
    await expect(row.getByRole('button', { name: 'Task options for Deeply nested task text should still have enough room to be comfortably readable' })).toHaveCount(0)
    const undo = page.getByRole('button', { name: 'Undo' })
    await expect(undo).toBeHidden()
  }

  await expect(text).toBeVisible()
  await expect(time).toBeVisible()
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-task-layout.png`,
    fullPage: false,
  })
})

test('mobile task options gate selection and open the large auto-saving time editor', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The task overflow interactions are mobile-only')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })

  await page.evaluate(() => {
    Object.defineProperty(navigator, 'vibrate', {
      configurable: true,
      value: (pattern: number | number[]) => {
        const testWindow = window as typeof window & { balanceTestVibrations?: Array<number | number[]> }
        testWindow.balanceTestVibrations = [
          ...(testWindow.balanceTestVibrations ?? []),
          Array.isArray(pattern) ? [...pattern] : pattern,
        ]
        return true
      },
    })
  })

  const untimedRow = page.getByRole('listitem', {
    name: 'Plan item: Another task used to verify mobile drag selection',
  })
  await expect(untimedRow.getByRole('button', { name: 'Add time range' })).toHaveCount(0)

  await untimedRow.getByRole('button', {
    name: 'Task options for Another task used to verify mobile drag selection',
  }).click()
  const menu = page.getByRole('menu', {
    name: 'Options for Another task used to verify mobile drag selection',
  })
  await expect(menu).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Add time' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Copy' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Cut' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Remove' })).toBeVisible()
  await expect(menu.getByRole('menuitem', { name: 'Select tasks' })).toBeVisible()

  await menu.getByRole('menuitem', { name: 'Add time' }).click()
  const dialog = page.getByRole('dialog', {
    name: 'Edit time for Another task used to verify mobile drag selection',
  })
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Save' })).toHaveCount(0)
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0)

  const editorWidth = await dialog.locator('.time-range.expanded').evaluate(
    (element) => element.getBoundingClientRect().width,
  )
  expect(editorWidth).toBeGreaterThan(300)
  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-time-editor.png',
    fullPage: false,
  })

  const start = dialog.getByRole('button', { name: /Start time/ })
  const originalStart = await start.innerText()
  await dragVertically(page, start, -34, 1)
  await expect(start).not.toHaveText(originalStart)
  const vibrationPatterns = await page.evaluate(
    () => (window as typeof window & { balanceTestVibrations?: Array<number | number[]> }).balanceTestVibrations ?? [],
  )
  expect(vibrationPatterns).toContainEqual([16, 24, 16, 24, 16])

  await page.locator('.mobile-time-editor-backdrop').click({ position: { x: 4, y: 4 } })
  await expect(dialog).toBeHidden()
  await expect(untimedRow.locator('.mobile-time-summary')).toBeVisible()

  await untimedRow.getByRole('button', {
    name: 'Task options for Another task used to verify mobile drag selection',
  }).click()
  await page.getByRole('menu', {
    name: 'Options for Another task used to verify mobile drag selection',
  }).getByRole('menuitem', { name: 'Select tasks' }).click()

  await expect(untimedRow.getByRole('button', {
    name: 'Deselect Another task used to verify mobile drag selection',
  })).toBeVisible()
  const parentRow = page.getByRole('listitem', { name: 'Plan item: Parent task with a scheduled time' })
  await tapAtCenter(page, parentRow.locator('[data-plan-text-input]'))
  await expect(page.locator('.plan-row.selected')).toHaveCount(2)

  const mobileHeader = page.locator('.mobile-app-header')
  const copySelected = mobileHeader.getByRole('button', { name: 'Copy selected tasks' })
  const undo = mobileHeader.getByRole('button', { name: 'Undo' })
  await expect(copySelected).toBeVisible()
  const [copyBox, undoBox] = await Promise.all([copySelected.boundingBox(), undo.boundingBox()])
  if (!copyBox || !undoBox) throw new Error('Missing mobile header action geometry')
  expect(copyBox.x + copyBox.width).toBeLessThanOrEqual(undoBox.x)
  await copySelected.click()
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
    'Parent task with a scheduled time',
    '  Nested task without a time',
    '    Deeply nested task text should still have enough room to be comfortably readable',
    'Another task used to verify mobile drag selection',
  ].join('\n'))
  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-task-selection.png',
    fullPage: false,
  })

  await tapAtCenter(page, untimedRow.locator('[data-plan-text-input]'))
  await tapAtCenter(page, parentRow.locator('[data-plan-text-input]'))
  await expect(page.locator('.plan-row.selected')).toHaveCount(0)
  await expect(copySelected).toHaveCount(0)
  await expect(parentRow.getByRole('button', {
    name: 'Task options for Parent task with a scheduled time',
  })).toBeVisible()

  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-task-options.png',
    fullPage: false,
  })
})

test('mobile task dragging auto-scrolls near both viewport edges', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The drag auto-scroll behavior is mobile-only')

  const viewport = page.viewportSize()
  if (!viewport) throw new Error('Missing mobile viewport')

  const firstHandle = page
    .getByRole('listitem', { name: 'Plan item: Parent task with a scheduled time' })
    .getByRole('button', { name: 'Drag to move item' })
  const firstHandleBox = await firstHandle.boundingBox()
  if (!firstHandleBox) throw new Error('Missing first drag handle geometry')

  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: firstHandleBox.x + firstHandleBox.width / 2, y: firstHandleBox.y + firstHandleBox.height / 2 }],
  })
  await expect(firstHandle).toHaveClass(/dragging/)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: firstHandleBox.x + firstHandleBox.width / 2, y: viewport.height - 4 }],
  })
  await expect(firstHandle).toHaveClass(/dragging/)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(100)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  const lowerHandle = page
    .getByRole('listitem', { name: 'Plan item: Filler task 12', exact: true })
    .getByRole('button', { name: 'Drag to move item' })
  await page.evaluate(() => window.scrollTo(0, 700))
  await lowerHandle.scrollIntoViewIfNeeded()
  const lowerHandleBox = await lowerHandle.boundingBox()
  if (!lowerHandleBox) throw new Error('Missing lower drag handle geometry')
  const startingScrollY = await page.evaluate(() => window.scrollY)
  expect(startingScrollY).toBeGreaterThan(100)

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: lowerHandleBox.x + lowerHandleBox.width / 2, y: lowerHandleBox.y + lowerHandleBox.height / 2 }],
  })
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: lowerHandleBox.x + lowerHandleBox.width / 2, y: 4 }],
  })
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeLessThan(startingScrollY - 80)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
})

test('mobile task options copy and cut whole task trees and remove tasks', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The task overflow interactions are mobile-only')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })

  const parentText = 'Parent task with a scheduled time'
  const parentRow = page.getByRole('listitem', { name: `Plan item: ${parentText}` })
  await parentRow.getByRole('button', { name: `Task options for ${parentText}` }).click()
  await parentRow.getByRole('menuitem', { name: 'Copy' }).click()

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
    parentText,
    '  Nested task without a time',
    '    Deeply nested task text should still have enough room to be comfortably readable',
  ].join('\n'))

  const target = page.locator('[data-plan-text-input-id="trailing"]')
  await target.focus()
  await page.keyboard.press('Meta+V')
  await expect(page.getByRole('listitem', { name: `Plan item: ${parentText}` })).toHaveCount(2)
  await expect(page.getByRole('listitem', { name: 'Plan item: Nested task without a time' })).toHaveCount(2)
  await page.keyboard.press('Escape')

  const trailingText = 'Another task used to verify mobile drag selection'
  const trailingRow = page.getByRole('listitem', { name: `Plan item: ${trailingText}` })
  await trailingRow.getByRole('button', { name: `Task options for ${trailingText}` }).click()
  await trailingRow.getByRole('menuitem', { name: 'Cut' }).click()
  await expect(trailingRow).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(trailingText)

  const removableText = 'Filler task 1'
  const removableRow = page.getByRole('listitem', { name: `Plan item: ${removableText}`, exact: true })
  await removableRow.getByRole('button', { name: `Task options for ${removableText}`, exact: true }).click()
  await removableRow.getByRole('menuitem', { name: 'Remove' }).click()
  await expect(removableRow).toHaveCount(0)
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
  const indentation = await page.evaluate(() => {
    const parent = document.querySelector<HTMLElement>('[data-plan-item-id="parent"]')
    const nested = document.querySelector<HTMLElement>('[data-plan-item-id="nested"]')
    const deepest = document.querySelector<HTMLElement>('[data-plan-item-id="deepest"]')
    if (!parent || !nested || !deepest) throw new Error('Missing nested task rows')
    return {
      firstLevel: nested.getBoundingClientRect().left - parent.getBoundingClientRect().left,
      secondLevel: deepest.getBoundingClientRect().left - nested.getBoundingClientRect().left,
    }
  })

  expect(textWidth).toBeGreaterThanOrEqual(170)
  expect(indentation.firstLevel).toBeGreaterThanOrEqual(8)
  expect(indentation.secondLevel).toBeGreaterThanOrEqual(8)
  await page.screenshot({
    path: 'artifacts/visual-smoke/mobile-320-task-layout.png',
    fullPage: false,
  })
})

test('day templates and lists fit an S10e-width viewport', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The regression is mobile-only')
  await page.setViewportSize({ width: 360, height: 760 })

  await page.getByRole('button', { name: 'Open navigation' }).click()
  const drawer = page.getByRole('complementary', { name: 'Primary navigation drawer' })
  await drawer.getByRole('button', { name: 'Day Templates', exact: true }).click()
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Daily template' })).toBeVisible()
  await expectPageToFitViewport(page)
  await expectControlToFitViewport(page, page.getByRole('button', { name: 'Mobile day', exact: true }))
  await page.screenshot({ path: 'artifacts/visual-smoke/mobile-s10e-day-templates.png', fullPage: false })

  await page.getByRole('button', { name: 'Open navigation' }).click()
  await drawer.getByRole('button', { name: 'Lists', exact: true }).click()
  await expect(drawer).toBeHidden()
  await expect(page.getByRole('heading', { name: 'Lists', exact: true })).toBeVisible()
  await expectPageToFitViewport(page)
  await expectControlToFitViewport(page, page.getByRole('button', { name: 'Groceries', exact: true }))
  await page.screenshot({ path: 'artifacts/visual-smoke/mobile-s10e-lists.png', fullPage: false })
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

async function tapAtCenter(
  page: import('@playwright/test').Page,
  target: import('@playwright/test').Locator,
) {
  const box = await target.boundingBox()
  if (!box) throw new Error('Missing tap target geometry')
  await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2)
}

async function dragVertically(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  deltaY: number,
  steps = 4,
) {
  const box = await source.boundingBox()
  if (!box) throw new Error('Missing vertical drag geometry')

  const x = box.x + box.width / 2
  const y = box.y + box.height / 2
  await page.mouse.move(x, y)
  await page.mouse.down()
  await page.mouse.move(x, y + deltaY, { steps })
  await page.mouse.up()
}

async function expectPageToFitViewport(page: import('@playwright/test').Page) {
  const result = await page.evaluate(() => ({
    body: document.body.scrollWidth - document.documentElement.clientWidth,
    shell: (document.querySelector<HTMLElement>('.app-shell')?.scrollWidth ?? 0) - window.innerWidth,
    workspace: (() => {
      const workspace = document.querySelector<HTMLElement>('.workspace')
      return workspace ? workspace.scrollWidth - workspace.clientWidth : -1
    })(),
    offenders: Array.from(document.querySelectorAll<HTMLElement>('body *'))
      .map((element) => {
        const rect = element.getBoundingClientRect()
        return { tag: element.tagName, className: element.className, left: rect.left, right: rect.right, width: rect.width }
      })
      .filter(({ left, right }) => left < 0 || right > window.innerWidth)
      .slice(0, 8),
  }))
  expect(
    { body: result.body, shell: result.shell, workspace: result.workspace },
    `Elements outside the viewport: ${JSON.stringify(result.offenders)}`,
  ).toEqual({ body: 0, shell: 0, workspace: 0 })
}

async function expectControlToFitViewport(
  page: import('@playwright/test').Page,
  control: import('@playwright/test').Locator,
) {
  const box = await control.boundingBox()
  expect(box).not.toBeNull()
  expect(box!.width).toBeGreaterThanOrEqual(50)
  expect(box!.x).toBeGreaterThanOrEqual(0)
  expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width)
}
