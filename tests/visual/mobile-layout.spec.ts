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
    const textStyle = getComputedStyle(textElement)
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
      textPaddingLeft: Number.parseFloat(textStyle.paddingLeft),
      textPaddingTop: Number.parseFloat(textStyle.paddingTop),
      textPaddingBottom: Number.parseFloat(textStyle.paddingBottom),
    }
  })

  if (isMobileProject(testInfo.project.name)) {
    expect(geometry.textWidth).toBeGreaterThanOrEqual(190)
    expect(geometry.timeTop).toBeLessThan(geometry.textTop)
    expect(Math.abs((geometry.taskTextLeft ?? 0) - geometry.timeLeft)).toBeLessThanOrEqual(1)
    expect(Math.abs((geometry.timeSpaceAbove ?? 0) - (geometry.timeSpaceBelow ?? 0))).toBeLessThanOrEqual(4)
    expect(geometry.textPaddingLeft).toBe(10)
    expect(geometry.textPaddingTop).toBe(geometry.textPaddingBottom)
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
    const header = page.locator('.mobile-app-header')
    const undo = header.getByRole('button', { name: 'Undo' })
    const redo = page.getByRole('button', { name: 'Redo' })
    const fixedButtonCentersBeforeUndo = await header.locator('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect()
        return { label: button.getAttribute('aria-label'), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }),
    )
    await expect(undo).toBeVisible()
    await expect(redo).toHaveCount(0)
    expect(new Set(fixedButtonCentersBeforeUndo.map(({ y }) => y)).size).toBe(1)
    await undo.click()
    await expect(checkbox).not.toBeChecked()
    await expect(redo).toBeVisible()
    const fixedButtonCentersAfterUndo = await header.locator('button').evaluateAll((buttons) =>
      buttons.map((button) => {
        const rect = button.getBoundingClientRect()
        return { label: button.getAttribute('aria-label'), x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
      }),
    )
    expect(fixedButtonCentersAfterUndo).toEqual(fixedButtonCentersBeforeUndo)
    await redo.click()
    await expect(checkbox).toBeChecked()
    await expect(redo).toHaveCount(0)

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
    touchPoints: [{ x: firstHandleBox.x + firstHandleBox.width / 2, y: viewport.height - 60 }],
  })
  await expect(firstHandle).toHaveClass(/dragging/)
  await page.waitForTimeout(250)
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [{ x: firstHandleBox.x + firstHandleBox.width / 2, y: viewport.height - 4 }],
  })
  await page.waitForTimeout(250)
  const downwardScrollY = await page.evaluate(() => window.scrollY)
  expect(downwardScrollY).toBeGreaterThan(20)
  expect(downwardScrollY).toBeLessThan(160)
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

test('starting a mobile task drag dismisses the active task editor', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'Touch keyboard dismissal is mobile-only')

  const row = page.getByRole('listitem', { name: 'Plan item: Parent task with a scheduled time' })
  const editor = row.locator('[data-plan-text-input]')
  const handle = row.getByRole('button', { name: 'Drag to move item' })
  await editor.focus()
  await expect(editor).toBeFocused()

  const handleBox = await handle.boundingBox()
  if (!handleBox) throw new Error('Missing drag handle geometry')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{ x: handleBox.x + handleBox.width / 2, y: handleBox.y + handleBox.height / 2 }],
  })

  await expect(handle).toHaveClass(/dragging/)
  await expect(editor).not.toBeFocused()
  await expect(page.locator('[data-plan-text-input]:focus')).toHaveCount(0)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
})

test('checking a task without an active mobile caret leaves task editors unfocused', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The no-caret completion behavior is mobile-only')

  const row = page.getByRole('listitem', { name: 'Plan item: Filler task 1', exact: true })
  const checkbox = row.getByRole('checkbox')
  const checkboxBox = await checkbox.boundingBox()
  if (!checkboxBox) throw new Error('Missing checkbox geometry')
  await page.evaluate(() => {
    document.getSelection()?.removeAllRanges()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
  })
  await expect(page.locator('[data-plan-text-input]:focus')).toHaveCount(0)

  await page.touchscreen.tap(
    checkboxBox.x + checkboxBox.width / 2,
    checkboxBox.y + checkboxBox.height / 2,
  )

  await expect(checkbox).toBeChecked()
  await expect(page.locator('[data-plan-text-input]:focus')).toHaveCount(0)
})

test('checking a task with an active mobile caret leaves task editors unfocused', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The no-caret completion behavior is mobile-only')

  const currentRow = page.getByRole('listitem', { name: 'Plan item: Filler task 1', exact: true })
  const currentEditor = currentRow.locator('[data-plan-text-input]')
  const checkbox = currentRow.getByRole('checkbox')
  await currentEditor.focus()

  const checkboxBox = await checkbox.boundingBox()
  if (!checkboxBox) throw new Error('Missing checkbox geometry')
  await page.touchscreen.tap(
    checkboxBox.x + checkboxBox.width / 2,
    checkboxBox.y + checkboxBox.height / 2,
  )

  await expect(checkbox).toBeChecked()
  await expect(page.locator('[data-plan-text-input]:focus')).toHaveCount(0)
})

test('holding a mobile checkbox then dragging checks every crossed task in one action', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The checkbox hold-and-drag gesture is mobile-only')

  const taskNames = [
    'Parent task with a scheduled time',
    'Nested task without a time',
    'Deeply nested task text should still have enough room to be comfortably readable',
    'Another task used to verify mobile drag selection',
  ]
  const rows = taskNames.map((name) => page.getByRole('listitem', { name: `Plan item: ${name}` }))
  const boxes = await Promise.all(rows.map((row) => row.getByRole('checkbox').boundingBox()))
  if (boxes.some((box) => !box)) throw new Error('Missing checkbox gesture geometry')

  const cdp = await page.context().newCDPSession(page)
  const origin = boxes[0]!
  const touchPoint = (box: NonNullable<(typeof boxes)[number]>) => ({
    x: box.x + box.width / 2,
    y: box.y + box.height / 2,
  })

  const leafCheckbox = page
    .getByRole('listitem', { name: 'Plan item: Filler task 1', exact: true })
    .getByRole('checkbox')
  const leafBox = await leafCheckbox.boundingBox()
  if (!leafBox) throw new Error('Missing leaf checkbox tap geometry')
  await page.touchscreen.tap(touchPoint(leafBox).x, touchPoint(leafBox).y)
  await expect(leafCheckbox).toBeChecked()
  await page.touchscreen.tap(touchPoint(leafBox).x, touchPoint(leafBox).y)
  await expect(leafCheckbox).not.toBeChecked()

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [touchPoint(origin)],
  })
  await page.waitForTimeout(1100)
  await expect(rows[0]).toHaveClass(/mobile-checkbox-drag-preview/)

  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchMove',
    touchPoints: [touchPoint(boxes.at(-1)!)],
  })
  await expect(page.locator('.plan-row.mobile-checkbox-drag-preview')).toHaveCount(taskNames.length)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  for (const row of rows) await expect(row.getByRole('checkbox')).toBeChecked()
  await expect(page.locator('.plan-row.mobile-checkbox-drag-preview')).toHaveCount(0)

  await page.locator('.mobile-app-header').getByRole('button', { name: 'Undo' }).click()
  for (const row of rows) await expect(row.getByRole('checkbox')).not.toBeChecked()
})

test('reversing a mobile checkbox drag unchecks tasks the finger retraces', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The checkbox hold-and-drag gesture is mobile-only')

  const rows = [1, 2, 3, 4].map((number) =>
    page.getByRole('listitem', { name: `Plan item: Filler task ${number}`, exact: true }),
  )
  const boxes = await Promise.all(rows.map((row) => row.getByRole('checkbox').boundingBox()))
  if (boxes.some((box) => !box)) throw new Error('Missing reversible checkbox gesture geometry')

  const cdp = await page.context().newCDPSession(page)
  const touchPoint = (index: number) => ({
    x: boxes[index]!.x + boxes[index]!.width / 2,
    y: boxes[index]!.y + boxes[index]!.height / 2,
  })
  const previewRows = page.locator('.plan-row.mobile-checkbox-drag-preview')

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(0)] })
  await page.waitForTimeout(1100)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(3)] })
  await expect(previewRows).toHaveCount(4)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(2)] })
  await expect(previewRows).toHaveCount(3)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(1)] })
  await expect(previewRows).toHaveCount(2)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  for (const row of rows.slice(0, 2)) await expect(row.getByRole('checkbox')).toBeChecked()
  for (const row of rows.slice(2)) await expect(row.getByRole('checkbox')).not.toBeChecked()

  await page.locator('.mobile-app-header').getByRole('button', { name: 'Undo' }).click()
  for (const row of rows) await expect(row.getByRole('checkbox')).not.toBeChecked()

  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [touchPoint(3)] })
  await page.waitForTimeout(1100)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(0)] })
  await expect(previewRows).toHaveCount(4)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(1)] })
  await expect(previewRows).toHaveCount(3)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [touchPoint(2)] })
  await expect(previewRows).toHaveCount(2)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })

  for (const row of rows.slice(0, 2)) await expect(row.getByRole('checkbox')).not.toBeChecked()
  for (const row of rows.slice(2)) await expect(row.getByRole('checkbox')).toBeChecked()
})

test('mobile task options stay inside the viewport at the top and bottom of the page', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The task overflow interactions are mobile-only')

  const topText = 'Parent task with a scheduled time'
  const topRow = page.getByRole('listitem', { name: `Plan item: ${topText}` })
  await topRow.scrollIntoViewIfNeeded()
  await topRow.locator('[data-plan-text-input]').focus()
  await topRow.getByRole('button', { name: `Task options for ${topText}` }).click()

  const topMenu = page.getByRole('menu', { name: `Options for ${topText}` })
  await expect(topMenu).toBeVisible()
  await expect(page.locator('[data-plan-text-input]:focus')).toHaveCount(0)
  const topBounds = await topRow.evaluate((element, menuLabel) => {
    const buttonRect = element.querySelector('.mobile-task-menu-button')?.getBoundingClientRect()
    const menu = Array.from(document.querySelectorAll<HTMLElement>('.mobile-task-menu'))
      .find((candidate) => candidate.getAttribute('aria-label') === menuLabel)
    const menuRect = menu?.getBoundingClientRect()
    if (!buttonRect || !menuRect) throw new Error('Missing mobile task menu geometry')
    const viewport = window.visualViewport
    return {
      top: menuRect.top,
      bottom: menuRect.bottom,
      buttonRight: buttonRect.right,
      menuRight: menuRect.right,
      menuParent: menu?.parentElement?.tagName,
      viewportTop: viewport?.offsetTop ?? 0,
      viewportBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
    }
  }, `Options for ${topText}`)
  expect(topBounds.top).toBeGreaterThanOrEqual(topBounds.viewportTop + 7)
  expect(topBounds.bottom).toBeLessThanOrEqual(topBounds.viewportBottom - 7)
  expect(Math.abs(topBounds.menuRight - topBounds.buttonRight)).toBeLessThanOrEqual(1)
  expect(topBounds.menuParent).toBe('BODY')

  await page.setViewportSize({ width: 360, height: 740 })
  await expect.poll(async () => topRow.evaluate((element, menuLabel) => {
    const buttonRect = element.querySelector('.mobile-task-menu-button')?.getBoundingClientRect()
    const menu = Array.from(document.querySelectorAll<HTMLElement>('.mobile-task-menu'))
      .find((candidate) => candidate.getAttribute('aria-label') === menuLabel)
    const menuRect = menu?.getBoundingClientRect()
    if (!buttonRect || !menuRect) return Number.POSITIVE_INFINITY
    const viewport = window.visualViewport
    const viewportLeft = viewport?.offsetLeft ?? 0
    const viewportRight = viewportLeft + (viewport?.width ?? window.innerWidth)
    const expectedLeft = Math.min(
      Math.max(buttonRect.right - menuRect.width, viewportLeft + 8),
      viewportRight - 8 - menuRect.width,
    )
    return Math.abs(menuRect.left - expectedLeft)
  }, `Options for ${topText}`)).toBeLessThanOrEqual(1)
  await page.keyboard.press('Escape')

  const bottomText = 'Filler task 28'
  const bottomRow = page.getByRole('listitem', { name: `Plan item: ${bottomText}`, exact: true })
  await bottomRow.evaluate((element) => element.scrollIntoView({ block: 'end' }))
  const bottomButton = bottomRow.getByRole('button', { name: `Task options for ${bottomText}`, exact: true })
  await bottomButton.click()

  const bottomMenu = page.getByRole('menu', { name: `Options for ${bottomText}`, exact: true })
  await expect(bottomMenu).toBeVisible()
  const bottomBounds = await bottomRow.evaluate((element, menuLabel) => {
    const buttonRect = element.querySelector('.mobile-task-menu-button')?.getBoundingClientRect()
    const menu = Array.from(document.querySelectorAll<HTMLElement>('.mobile-task-menu'))
      .find((candidate) => candidate.getAttribute('aria-label') === menuLabel)
    const menuRect = menu?.getBoundingClientRect()
    const viewport = window.visualViewport
    if (!buttonRect || !menuRect) throw new Error('Missing mobile task menu geometry')
    return {
      buttonTop: buttonRect.top,
      buttonRight: buttonRect.right,
      menuTop: menuRect.top,
      menuBottom: menuRect.bottom,
      menuRight: menuRect.right,
      menuLeft: menuRect.left,
      menuWidth: menuRect.width,
      viewportLeft: viewport?.offsetLeft ?? 0,
      viewportRight: (viewport?.offsetLeft ?? 0) + (viewport?.width ?? window.innerWidth),
      viewportTop: viewport?.offsetTop ?? 0,
      viewportBottom: (viewport?.offsetTop ?? 0) + (viewport?.height ?? window.innerHeight),
    }
  }, `Options for ${bottomText}`)
  expect(bottomBounds.menuTop).toBeLessThan(bottomBounds.buttonTop)
  const expectedBottomLeft = Math.min(
    Math.max(bottomBounds.buttonRight - bottomBounds.menuWidth, bottomBounds.viewportLeft + 8),
    bottomBounds.viewportRight - 8 - bottomBounds.menuWidth,
  )
  expect(Math.abs(bottomBounds.menuLeft - expectedBottomLeft)).toBeLessThanOrEqual(1)
  expect(bottomBounds.menuTop).toBeGreaterThanOrEqual(bottomBounds.viewportTop + 7)
  expect(bottomBounds.menuBottom).toBeLessThanOrEqual(bottomBounds.viewportBottom - 7)
})

test('mobile task options open on touch press before a keyboard resize can cancel the click', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The task overflow interactions are mobile-only')

  const taskText = 'Parent task with a scheduled time'
  const row = page.getByRole('listitem', { name: `Plan item: ${taskText}` })
  const editor = row.locator('[data-plan-text-input]')
  const menuButton = row.getByRole('button', { name: `Task options for ${taskText}` })
  await editor.focus()

  const menuButtonBox = await menuButton.boundingBox()
  if (!menuButtonBox) throw new Error('Missing mobile task options button geometry')
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchStart',
    touchPoints: [{
      x: menuButtonBox.x + menuButtonBox.width / 2,
      y: menuButtonBox.y + menuButtonBox.height / 2,
    }],
  })

  await expect(page.getByRole('menu', { name: `Options for ${taskText}` })).toBeVisible()
  await expect(page.locator('[data-plan-text-input]:focus')).toHaveCount(0)
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
  await expect(page.getByRole('menu', { name: `Options for ${taskText}` })).toBeVisible()
  await page.screenshot({ path: 'artifacts/visual-smoke/mobile-task-menu-touch-open.png', fullPage: false })

  await page.touchscreen.tap(
    menuButtonBox.x + menuButtonBox.width / 2,
    menuButtonBox.y + menuButtonBox.height / 2,
  )
  await expect(page.getByRole('menu', { name: `Options for ${taskText}` })).toHaveCount(0)

  await menuButton.press('Enter')
  await expect(page.getByRole('menu', { name: `Options for ${taskText}` })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu', { name: `Options for ${taskText}` })).toHaveCount(0)

  await page.touchscreen.tap(
    menuButtonBox.x + menuButtonBox.width / 2,
    menuButtonBox.y + menuButtonBox.height / 2,
  )
  await expect(page.getByRole('menu', { name: `Options for ${taskText}` })).toBeVisible()
  const headerBox = await page.locator('.mobile-app-header').boundingBox()
  if (!headerBox) throw new Error('Missing mobile app header geometry')
  await page.touchscreen.tap(headerBox.x + headerBox.width / 2, headerBox.y + headerBox.height / 2)
  await expect(page.getByRole('menu', { name: `Options for ${taskText}` })).toHaveCount(0)
})

test('mobile task options stay open when the compatibility click is delayed by keyboard dismissal', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The task overflow interactions are mobile-only')

  const taskText = 'Parent task with a scheduled time'
  const row = page.getByRole('listitem', { name: `Plan item: ${taskText}` })
  const editor = row.locator('[data-plan-text-input]')
  const menuButton = row.getByRole('button', { name: `Task options for ${taskText}` })
  const menu = page.getByRole('menu', { name: `Options for ${taskText}` })
  await editor.focus()

  await menuButton.dispatchEvent('pointerdown', {
    button: 0,
    buttons: 1,
    isPrimary: true,
    pointerId: 7,
    pointerType: 'touch',
  })
  await expect(menu).toBeVisible()
  await menuButton.dispatchEvent('pointerup', {
    button: 0,
    buttons: 0,
    isPrimary: true,
    pointerId: 7,
    pointerType: 'touch',
  })

  // Android can hold the compatibility click while its software keyboard and
  // visual viewport settle. That click belongs to the press that already
  // opened the menu, however late it arrives, and must not toggle it closed.
  await page.waitForTimeout(800)
  await menuButton.evaluate((button) => {
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, button: 0, detail: 1 }))
  })
  await expect(menu).toBeVisible()
})

test('holding and dragging a checkbox does not bulk-check tasks on desktop', async ({ page }, testInfo) => {
  test.skip(isMobileProject(testInfo.project.name), 'Desktop-only mobile gesture guard')

  const origin = page
    .getByRole('listitem', { name: 'Plan item: Parent task with a scheduled time' })
    .getByRole('checkbox')
  const target = page
    .getByRole('listitem', { name: 'Plan item: Another task used to verify mobile drag selection' })
    .getByRole('checkbox')

  const [originBox, targetBox] = await Promise.all([origin.boundingBox(), target.boundingBox()])
  if (!originBox || !targetBox) throw new Error('Missing desktop checkbox gesture geometry')
  await page.mouse.move(originBox.x + originBox.width / 2, originBox.y + originBox.height / 2)
  await page.mouse.down()
  await page.waitForTimeout(1100)
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2)
  await page.mouse.up()

  await expect(target).not.toBeChecked()
  await expect(page.locator('.plan-row.mobile-checkbox-drag-preview')).toHaveCount(0)
})

test('mobile task options edit, add, and remove time and start task selection', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The task overflow interactions are mobile-only')

  const parentText = 'Parent task with a scheduled time'
  const parentRow = page.getByRole('listitem', { name: `Plan item: ${parentText}` })
  await parentRow.getByRole('button', { name: `Task options for ${parentText}` }).click()
  await page.getByRole('menuitem', { name: 'Edit time' }).click()
  await expect(page.getByRole('dialog', { name: `Edit time for ${parentText}` })).toBeVisible()
  await page.keyboard.press('Escape')

  await parentRow.getByRole('button', { name: `Task options for ${parentText}` }).click()
  await page.getByRole('menuitem', { name: 'Remove time' }).click()
  await expect(parentRow.locator('.mobile-time-summary')).toHaveCount(0)

  const trailingText = 'Another task used to verify mobile drag selection'
  const trailingRow = page.getByRole('listitem', { name: `Plan item: ${trailingText}` })
  await trailingRow.getByRole('button', { name: `Task options for ${trailingText}` }).click()
  await page.getByRole('menuitem', { name: 'Add time' }).click()
  await expect(page.getByRole('dialog', { name: `Edit time for ${trailingText}` })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(trailingRow.locator('.mobile-time-summary')).toBeVisible()

  const selectableText = 'Filler task 1'
  const selectableRow = page.getByRole('listitem', { name: `Plan item: ${selectableText}`, exact: true })
  await selectableRow.getByRole('button', { name: `Task options for ${selectableText}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Select tasks' }).click()
  await expect(selectableRow.getByRole('button', { name: `Deselect ${selectableText}`, exact: true })).toBeVisible()
  await expect(page.locator('.mobile-task-menu-button')).toHaveCount(0)
})

test('mobile task options copy and cut whole task trees and remove tasks', async ({ page }, testInfo) => {
  test.skip(!isMobileProject(testInfo.project.name), 'The task overflow interactions are mobile-only')
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(page.url()).origin })

  const parentText = 'Parent task with a scheduled time'
  const parentRow = page.getByRole('listitem', { name: `Plan item: ${parentText}` })
  await parentRow.getByRole('button', { name: `Task options for ${parentText}` }).click()
  await page.getByRole('menuitem', { name: 'Copy' }).click()

  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe([
    parentText,
    '  Nested task without a time',
    '    Deeply nested task text should still have enough room to be comfortably readable',
  ].join('\n'))

  const trailingText = 'Another task used to verify mobile drag selection'
  const trailingRow = page.getByRole('listitem', { name: `Plan item: ${trailingText}` })
  await trailingRow.getByRole('button', { name: `Task options for ${trailingText}` }).click()
  await page.getByRole('menuitem', { name: 'Paste' }).click()
  await expect(page.getByRole('listitem', { name: `Plan item: ${parentText}` })).toHaveCount(2)
  await expect(page.getByRole('listitem', { name: 'Plan item: Nested task without a time' })).toHaveCount(2)
  await page.keyboard.press('Escape')

  await trailingRow.getByRole('button', { name: `Task options for ${trailingText}` }).click()
  await page.getByRole('menuitem', { name: 'Cut' }).click()
  await expect(trailingRow).toHaveCount(0)
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(trailingText)

  const removableText = 'Filler task 1'
  const removableRow = page.getByRole('listitem', { name: `Plan item: ${removableText}`, exact: true })
  await removableRow.getByRole('button', { name: `Task options for ${removableText}`, exact: true }).click()
  await page.getByRole('menuitem', { name: 'Remove' }).click()
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
