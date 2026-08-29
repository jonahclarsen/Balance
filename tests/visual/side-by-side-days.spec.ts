import { expect, test, type Locator, type Page } from '@playwright/test'

// Drags one item's handle onto a target row. The drag handles use pointer capture
// and resolve their drop target with elementFromPoint, so a real mouse press +
// move + release is what exercises them.
async function dragItemOnto(page: Page, handle: Locator, target: Locator, edge: 'top' | 'bottom' = 'top') {
  const handleBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  if (!handleBox || !targetBox) throw new Error('Expected both the drag handle and the drop target to be visible')

  const dropY = edge === 'top' ? targetBox.y + targetBox.height * 0.15 : targetBox.y + targetBox.height * 0.85

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  // An intermediate move makes the drop marker resolve before the release.
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 })
  await page.mouse.move(targetBox.x + targetBox.width / 2, dropY, { steps: 4 })
  await page.mouse.up()
}

function paneFor(page: Page, name: 'Daily plan' | 'Compared day') {
  return page.getByRole('region', { name })
}

async function openTwoGeneratedDays(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()

  await page.getByRole('button', { name: 'Compare with another day' }).click()

  const comparePane = paneFor(page, 'Compared day')
  await expect(comparePane).toBeVisible()
  await comparePane.getByRole('radio', { name: 'Default day' }).check()
  await comparePane.getByRole('button', { name: 'Generate this day' }).click()
  await expect(comparePane.locator('[data-plan-text-input]').first()).toBeVisible()
}

test('two days show side by side and items can be dragged between them', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The panes stack on mobile; dragging is covered on desktop.')

  await openTwoGeneratedDays(page)

  const primaryPane = paneFor(page, 'Daily plan')
  const comparePane = paneFor(page, 'Compared day')

  // The comparison day defaults to the day after the active one.
  const primaryDate = await primaryPane.locator('.date-input').inputValue()
  const compareDate = await comparePane.locator('.date-input').inputValue()
  expect(new Date(`${compareDate}T00:00:00Z`).getTime() - new Date(`${primaryDate}T00:00:00Z`).getTime()).toBe(
    24 * 60 * 60 * 1000,
  )

  await expect(primaryPane.locator('[data-plan-item-id]')).toHaveCount(5)
  await expect(comparePane.locator('[data-plan-item-id]')).toHaveCount(5)

  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-side-by-side-days.png`,
    fullPage: true,
  })

  // "Work block" carries two children, so this also proves a subtree moves whole.
  const movedRow = primaryPane.locator('[data-plan-item-id]').filter({ hasText: 'Work block' }).first()
  const movedItemId = await movedRow.getAttribute('data-plan-item-id')
  const handle = movedRow.getByRole('button', { name: 'Drag to move item' })
  const target = comparePane.locator('[data-plan-item-id]').first()

  await dragItemOnto(page, handle, target)

  await expect(primaryPane.locator(`[data-plan-item-id="${movedItemId}"]`)).toHaveCount(0)
  await expect(comparePane.locator(`[data-plan-item-id="${movedItemId}"]`)).toHaveCount(1)
  await expect(primaryPane.locator('[data-plan-item-id]')).toHaveCount(2)
  await expect(comparePane.locator('[data-plan-item-id]')).toHaveCount(8)
  // The child rows came along rather than being stranded in the old day. Both days
  // were generated from the same template, so the compare pane now holds two.
  await expect(primaryPane.locator('[data-plan-item-id]').filter({ hasText: 'Write down next action' })).toHaveCount(0)
  await expect(comparePane.locator('[data-plan-item-id]').filter({ hasText: 'Write down next action' })).toHaveCount(2)

  // A single undo puts the whole subtree back where it started.
  await page.keyboard.press('ControlOrMeta+z')
  await expect(primaryPane.locator(`[data-plan-item-id="${movedItemId}"]`)).toHaveCount(1)
  await expect(primaryPane.locator('[data-plan-item-id]')).toHaveCount(5)
  await expect(comparePane.locator('[data-plan-item-id]')).toHaveCount(5)
})

test('each side-by-side day scrolls independently', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Mobile comparison panes stack in the document flow.')

  await openTwoGeneratedDays(page)
  await page.setViewportSize({ width: 1000, height: 430 })

  const primaryPane = paneFor(page, 'Daily plan')
  const comparePane = paneFor(page, 'Compared day')
  await expect
    .poll(() => primaryPane.evaluate((pane) => pane.scrollHeight > pane.clientHeight))
    .toBe(true)
  await expect
    .poll(() => comparePane.evaluate((pane) => pane.scrollHeight > pane.clientHeight))
    .toBe(true)

  await primaryPane.evaluate((pane) => pane.scrollTo(0, pane.scrollHeight))
  const primaryScrollTop = await primaryPane.evaluate((pane) => pane.scrollTop)
  expect(primaryScrollTop).toBeGreaterThan(0)
  await expect.poll(() => comparePane.evaluate((pane) => pane.scrollTop)).toBe(0)

  await comparePane.evaluate((pane) => pane.scrollTo(0, pane.scrollHeight))
  await expect.poll(() => comparePane.evaluate((pane) => pane.scrollTop)).toBeGreaterThan(0)
  await expect.poll(() => primaryPane.evaluate((pane) => pane.scrollTop)).toBe(primaryScrollTop)
})

test('opening comparison from tomorrow shows today followed by tomorrow', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  const primaryDateInput = paneFor(page, 'Daily plan').locator('.date-input')
  const today = await primaryDateInput.inputValue()
  const tomorrow = new Date(`${today}T00:00:00Z`)
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1)
  const tomorrowISO = tomorrow.toISOString().slice(0, 10)

  await primaryDateInput.fill(tomorrowISO)
  await page.getByRole('button', { name: 'Compare with another day' }).click()

  await expect(paneFor(page, 'Daily plan').locator('.date-input')).toHaveValue(today)
  await expect(paneFor(page, 'Compared day').locator('.date-input')).toHaveValue(tomorrowISO)
})

test('dropping on empty panel space appends to the end of the other day', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The panes stack on mobile; dragging is covered on desktop.')

  await openTwoGeneratedDays(page)

  const primaryPane = paneFor(page, 'Daily plan')
  const comparePane = paneFor(page, 'Compared day')

  const movedRow = primaryPane.locator('[data-plan-item-id]').filter({ hasText: 'Wake up' }).first()
  const movedItemId = await movedRow.getAttribute('data-plan-item-id')
  const handle = movedRow.getByRole('button', { name: 'Drag to move item' })

  // The "+ Add item" row sits inside the panel but outside every item row, so it
  // stands in for the panel's empty tail.
  await dragItemOnto(page, handle, comparePane.getByRole('button', { name: '+ Add item' }))

  const compareIds = comparePane.locator('[data-plan-item-id]')
  await expect(compareIds).toHaveCount(6)
  await expect(compareIds.last()).toHaveAttribute('data-plan-item-id', movedItemId ?? '')
})

test('selection and arrow navigation stay inside the pane you last touched', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Selection handles are mouse-only.')

  await openTwoGeneratedDays(page)

  const primaryPane = paneFor(page, 'Daily plan')
  const comparePane = paneFor(page, 'Compared day')

  // Selecting in the compare pane must aim the plan shortcuts at that day.
  await comparePane.locator('[data-plan-item-id]').first().getByRole('button', { name: 'Select item' }).click()
  await page.keyboard.press('ControlOrMeta+d')
  await expect(comparePane.locator('[data-plan-item-id]').first()).toHaveClass(/done/)
  await expect(primaryPane.locator('.plan-row.done')).toHaveCount(0)

  // Arrow keys must not walk out of the last row of one day into the next day.
  const lastPrimaryInput = primaryPane.locator('[data-plan-text-input]').last()
  await lastPrimaryInput.click()
  await page.keyboard.press('ArrowDown')
  await expect(lastPrimaryInput).toBeFocused()
})

test('the comparison toggles with Alt+B and survives a reload', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await expect(paneFor(page, 'Compared day')).toHaveCount(0)

  await page.keyboard.press('Alt+b')
  await expect(paneFor(page, 'Compared day')).toBeVisible()

  await page.reload()
  await expect(paneFor(page, 'Compared day')).toBeVisible()

  await page.keyboard.press('Alt+b')
  await expect(paneFor(page, 'Compared day')).toHaveCount(0)

  await page.reload()
  await expect(paneFor(page, 'Compared day')).toHaveCount(0)
})

test('cut nested children stay removed after paste, comparison layout, and reload', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The reported cut and split-view sequence is a desktop workflow.')

  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const primaryPane = paneFor(page, 'Daily plan')
  const original = await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const plan = state.plans?.find((candidate: { date: string }) => candidate.date === state.activePlanDate)
    const parent = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
    return {
      parentId: parent?.id as string,
      childIds: (parent?.children ?? []).map((child: { id: string }) => child.id) as string[],
    }
  })
  expect(original.childIds).toHaveLength(2)

  // Select only the two children at position A, exactly as a keyboard cut does.
  await primaryPane.locator('[data-plan-text-input]').filter({ hasText: 'Pick the first useful task' }).click()
  await page.keyboard.press('Meta+Shift+A')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(primaryPane.locator('.plan-row.selected')).toHaveCount(2)
  await page.keyboard.press('Meta+X')

  await expect(primaryPane.locator(`[data-plan-item-id="${original.childIds[0]}"]`)).toHaveCount(0)
  await expect(primaryPane.locator(`[data-plan-item-id="${original.childIds[1]}"]`)).toHaveCount(0)
  await expect.poll(() => storedTree(page, original.parentId)).toEqual({ done: false, children: [] })

  // Paste the cut tasks at position B. A cut/paste deliberately creates new ids;
  // the old ids must never reappear in either storage or the rendered tree.
  await primaryPane.locator('[data-plan-text-input]').filter({ hasText: 'Wake up' }).click()
  await page.keyboard.press('Meta+V')
  await expect.poll(() => storedChildMove(page, original.parentId, original.childIds)).toEqual({
    originalParent: { done: false, children: [] },
    oldIdsPresent: false,
    pastedTexts: ['Pick the first useful task', 'Write down next action'],
    pastedIdsDiffer: true,
  })
  await page.getByRole('button', { name: 'Compare with another day' }).click()
  await expect(paneFor(page, 'Compared day')).toBeVisible()
  await page.getByRole('button', { name: 'Close day comparison' }).click()
  await expect(paneFor(page, 'Compared day')).toHaveCount(0)
  await expect.poll(() => storedChildMove(page, original.parentId, original.childIds)).toEqual({
    originalParent: { done: false, children: [] },
    oldIdsPresent: false,
    pastedTexts: ['Pick the first useful task', 'Write down next action'],
    pastedIdsDiffer: true,
  })
  await expect(primaryPane.locator('[data-plan-text-input]').filter({ hasText: 'Pick the first useful task' })).toHaveCount(1)
  await expect(primaryPane.locator('[data-plan-text-input]').filter({ hasText: 'Write down next action' })).toHaveCount(1)

  await testInfo.attach('nested-cut-paste-after-comparison', {
    body: await page.screenshot({ fullPage: true }),
    contentType: 'image/png',
  })

  await page.reload()
  await expect.poll(() => storedChildMove(page, original.parentId, original.childIds)).toEqual({
    originalParent: { done: false, children: [] },
    oldIdsPresent: false,
    pastedTexts: ['Pick the first useful task', 'Write down next action'],
    pastedIdsDiffer: true,
  })
  await expect(primaryPane.locator(`[data-plan-item-id="${original.childIds[0]}"]`)).toHaveCount(0)
  await expect(primaryPane.locator(`[data-plan-item-id="${original.childIds[1]}"]`)).toHaveCount(0)
  await expect(primaryPane.locator('[data-plan-text-input]').filter({ hasText: 'Pick the first useful task' })).toHaveCount(1)
  await expect(primaryPane.locator('[data-plan-text-input]').filter({ hasText: 'Write down next action' })).toHaveCount(1)
})

test('three tasks cut to tomorrow never render back on the completed source day', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The reported cut and split-view sequence is a desktop workflow.')

  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  const logicalToday = await paneFor(page, 'Daily plan').locator('.date-input').inputValue()
  const dates = await page.evaluate((today) => {
    localStorage.clear()
    const tomorrowDate = new Date(`${today}T12:00:00`)
    tomorrowDate.setDate(tomorrowDate.getDate() + 1)
    const tomorrow = tomorrowDate.toISOString().slice(0, 10)
    const item = (id: string, text: string, done = false, children: unknown[] = []) => ({
      id,
      text,
      html: text,
      done,
      startMinutes: null,
      endMinutes: null,
      children,
    })
    const retained = Array.from({ length: 8 }, (_, index) =>
      item(`retained-${index}`, `Retained source task ${index}`, index < 7),
    )
    const moved = Array.from({ length: 3 }, (_, index) =>
      item(`original-moved-${index}`, `Synthetic moved task ${index}`),
    )
    const completedChild = (root: number, child: number) =>
      item(`trace-child-${root}-${child}`, `Completed trace child ${root}-${child}`, true)
    const traceShapedRoots = Array.from({ length: 19 }, (_, root) =>
      item(
        `trace-root-${root}`,
        `Completed trace root ${root}`,
        true,
        root >= 8 ? [completedChild(root, 0), completedChild(root, 1)] : [],
      ),
    )
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      schemaVersion: 1,
      deviceId: 'trace-repro-device',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: today,
      templates: [],
      plans: [
        { id: 'source-plan', date: today, dailyReminder: '', items: [...retained, ...moved] },
        { id: 'target-plan', date: tomorrow, dailyReminder: '', items: traceShapedRoots },
      ],
      goals: [],
      goalCompletions: [],
      operations: [],
    }))
    return { today, tomorrow }
  }, logicalToday)
  await page.reload()

  const primaryPane = paneFor(page, 'Daily plan')
  const sourceDate = primaryPane.locator('.date-input')
  const movedText = (index: number) => `Synthetic moved task ${index}`
  const row = (text: string) => primaryPane.getByRole('listitem', { name: `Plan item: ${text}`, exact: true })

  await row(movedText(0)).locator('[data-plan-text-input]').click()
  await page.keyboard.press('Meta+Shift+A')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await expect(primaryPane.locator('.plan-row.selected')).toHaveCount(3)
  await page.keyboard.press('Meta+X')
  for (let index = 0; index < 3; index += 1) await expect(row(movedText(index))).toHaveCount(0)

  await sourceDate.fill(dates.tomorrow)
  await expect(row('Completed trace root 0')).toBeVisible()
  await row('Completed trace root 18').locator('[data-plan-text-input]').click()
  await page.keyboard.press('Meta+V')
  for (let index = 0; index < 3; index += 1) await expect(row(movedText(index))).toHaveCount(1)

  await sourceDate.fill(dates.today)
  await expect(row('Retained source task 7')).toBeVisible()
  const finalSourceCheckbox = row('Retained source task 7').getByRole('checkbox', { name: 'Complete item' })
  await finalSourceCheckbox.check()
  await row('Retained source task 6').getByRole('checkbox', { name: 'Complete item' }).uncheck()
  await row('Retained source task 6').getByRole('checkbox', { name: 'Complete item' }).check()
  await expect(primaryPane.locator('.plan-row.done')).toHaveCount(8)

  await page.getByRole('button', { name: 'Compare with another day' }).click()
  await expect(paneFor(page, 'Compared day')).toBeVisible()
  await page.setViewportSize({ width: 760, height: 850 })
  await page.setViewportSize({ width: 1280, height: 850 })
  await page.getByRole('button', { name: 'Close day comparison' }).click()
  await page.waitForTimeout(2_500)
  await page.reload()

  await expect(sourceDate).toHaveValue(dates.today)
  await expect(primaryPane.locator('[data-plan-item-id]')).toHaveCount(8)
  await expect(primaryPane.locator('.plan-row.done')).toHaveCount(8)
  for (let index = 0; index < 3; index += 1) await expect(row(movedText(index))).toHaveCount(0)

  await sourceDate.fill(dates.tomorrow)
  await expect(primaryPane.locator('[data-plan-item-id]')).toHaveCount(44)
  for (let index = 0; index < 3; index += 1) {
    await expect(row(movedText(index))).toHaveCount(1)
    await expect(row(movedText(index)).getByRole('checkbox', { name: 'Complete item' })).not.toBeChecked()
  }

  const stored = await page.evaluate(({ today, tomorrow }) => {
    type Item = { id: string; text: string; done: boolean; children: Item[] }
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const flatten = (items: Item[]): Item[] => items.flatMap((candidate) => [candidate, ...flatten(candidate.children)])
    const itemsFor = (date: string) => flatten(state.plans.find((plan: { date: string }) => plan.date === date).items)
    const source = itemsFor(today)
    const target = itemsFor(tomorrow)
    return {
      sourceCount: source.length,
      sourceDone: source.filter((item) => item.done).length,
      sourceMoved: source.filter((item) => item.text.startsWith('Synthetic moved task')).length,
      targetCount: target.length,
      targetMoved: target.filter((item) => item.text.startsWith('Synthetic moved task')).length,
      oldIdsPresent: [...source, ...target].some((item) => item.id.startsWith('original-moved-')),
    }
  }, dates)
  expect(stored).toEqual({
    sourceCount: 8,
    sourceDone: 8,
    sourceMoved: 0,
    targetCount: 44,
    targetMoved: 3,
    oldIdsPresent: false,
  })
})

test('render diagnostics retain text-free checkbox state after leaving the planner', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The DOM diagnostic is shared; this sequence targets the reported Mac view.')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await expect(page.locator('[data-plan-item-id]').first()).toBeVisible()

  const captured = await page.evaluate(async () => {
    const diagnosticsPath = '/src/lib/renderedPlanDiagnostics.ts'
    const diagnostics = await import(/* @vite-ignore */ diagnosticsPath)
    const row = document.querySelector<HTMLElement>('[data-plan-item-id]')
    const checkbox = row?.querySelector<HTMLInputElement>(':scope > .check-target > input.check')
    if (!row || !checkbox) throw new Error('Expected a rendered plan checkbox')
    checkbox.checked = true
    diagnostics.captureRenderedPlanSnapshot()
    return diagnostics.getLastRenderedPlanSnapshot()
  })
  expect(captured?.panes[0].rows[0]).toMatchObject({
    rowIndex: 0,
    depth: 0,
    checkboxCount: 1,
    checkboxChecked: true,
    rowDoneClass: false,
    editorDoneClass: false,
  })
  expect(JSON.stringify(captured)).not.toContain('Wake up')
  expect(JSON.stringify(captured)).not.toContain('Work block')

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  const retained = await page.evaluate(async () => {
    const diagnosticsPath = '/src/lib/renderedPlanDiagnostics.ts'
    const diagnostics = await import(/* @vite-ignore */ diagnosticsPath)
    return diagnostics.getLastRenderedPlanSnapshot()
  })
  expect(retained?.panes[0].rows[0].checkboxChecked).toBe(true)
  expect(retained?.panes[0].rows.length).toBe(captured?.panes[0].rows.length)
})

async function storedTree(page: Page, parentId: string) {
  return page.evaluate((expectedParentId) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const plan = state.plans?.find((candidate: { date: string }) => candidate.date === state.activePlanDate)
    const parent = plan?.items?.find((item: { id: string }) => item.id === expectedParentId)
    return {
      done: parent?.done ?? null,
      children: (parent?.children ?? []).map((child: { id: string }) => child.id),
    }
  }, parentId)
}

async function storedChildMove(page: Page, parentId: string, originalChildIds: string[]) {
  return page.evaluate(({ expectedParentId, oldIds }) => {
    type Item = { id: string; text: string; done: boolean; children: Item[] }
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const plan = state.plans?.find((candidate: { date: string }) => candidate.date === state.activePlanDate)
    const items = (plan?.items ?? []) as Item[]
    const flattened: Item[] = []
    const visit = (nodes: Item[]) => nodes.forEach((item) => {
      flattened.push(item)
      visit(item.children)
    })
    visit(items)
    const parent = flattened.find((item) => item.id === expectedParentId)
    const pasted = items.filter((item) =>
      item.text === 'Pick the first useful task' || item.text === 'Write down next action',
    )
    return {
      originalParent: {
        done: parent?.done ?? null,
        children: parent?.children.map((child) => child.id) ?? [],
      },
      oldIdsPresent: flattened.some((item) => oldIds.includes(item.id)),
      pastedTexts: pasted.map((item) => item.text),
      pastedIdsDiffer: pasted.length === 2 && pasted.every((item) => !oldIds.includes(item.id)),
    }
  }, { expectedParentId: parentId, oldIds: originalChildIds })
}
