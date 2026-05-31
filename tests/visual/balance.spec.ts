import { expect, test } from '@playwright/test'

test('core planner screens render and screenshot cleanly', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await expect(page.getByRole('heading', { name: 'Balance' })).toBeVisible()
  const generateButton = page.getByRole('complementary').getByRole('button', { name: 'Generate today' })
  await expect(generateButton).toBeVisible()

  await generateButton.click()
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()
  const renderedDate = await page.locator('.date-input').inputValue()
  await page.getByRole('button', { name: 'Next day' }).click()
  await expect(page.locator('.date-input')).toHaveValue(addDays(renderedDate, 1))
  await page.getByRole('button', { name: 'Previous day' }).click()
  await expect(page.locator('.date-input')).toHaveValue(renderedDate)
  await page.keyboard.press('Alt+W')
  await expect(page.locator('.date-input')).toHaveValue(addDays(renderedDate, 1))
  await page.keyboard.press('Alt+Q')
  await expect(page.locator('.date-input')).toHaveValue(renderedDate)
  await expect(page.getByRole('button', { name: 'Drag to move item' }).first()).toBeVisible()
  await expect
    .poll(async () =>
      page.getByRole('button', { name: 'Drag to move item' }).first().evaluate((handle) => {
        const dots = handle.querySelector('.handle-dots')
        if (!(dots instanceof HTMLElement)) return false
        const style = getComputedStyle(dots)
        const box = dots.getBoundingClientRect()
        return box.width >= 12 && box.height >= 16 && style.backgroundImage.includes('radial-gradient')
      }),
    )
    .toBe(true)
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-today.png`,
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Templates' }).click()
  await expect(page.getByRole('heading', { name: 'Daily template' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Drag to move template item' }).first()).toBeVisible()
  await expect
    .poll(async () =>
      page.getByRole('button', { name: 'Drag to move template item' }).first().evaluate((handle) => {
        const dots = handle.querySelector('.handle-dots')
        if (!(dots instanceof HTMLElement)) return false
        const style = getComputedStyle(dots)
        const box = dots.getBoundingClientRect()
        return box.width >= 12 && box.height >= 16 && style.backgroundImage.includes('radial-gradient')
      }),
    )
    .toBe(true)
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-templates.png`,
    fullPage: true,
  })

  await page.getByRole('button', { name: 'History' }).click()
  await expect(page.getByRole('heading', { name: 'Saved days' })).toBeVisible()
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-history.png`,
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Export' }).click()
  await expect(page.getByRole('heading', { name: 'Export everything' })).toBeVisible()
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-export.png`,
    fullPage: true,
  })

  await page.getByRole('button', { name: 'Settings' }).click()
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible()
  await expect(page.getByText('Browser downloads')).toBeVisible()
  await page.screenshot({
    path: `artifacts/visual-smoke/${testInfo.project.name}-settings.png`,
    fullPage: true,
  })
})

test('daily reminder edits the selected day and future days inherit it', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const currentDate = await page.locator('.date-input').inputValue()
  const nextDate = addDays(currentDate, 1)

  await page.getByRole('button', { name: /This shouldn't be aspirational/ }).click()
  await page.getByLabel('Edit daily reminder').fill('Keep it concrete')

  await expect
    .poll(async () =>
      page.evaluate((date) => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.plans?.find((plan: { date: string }) => plan.date === date)?.dailyReminder
      }, currentDate),
    )
    .toBe('Keep it concrete')

  await page.locator('.date-input').fill(nextDate)
  await page.getByRole('complementary').getByRole('button', { name: 'Generate selected day' }).click()

  await expect(page.getByRole('button', { name: /Keep it concrete/ })).toBeVisible()
  await expect
    .poll(async () =>
      page.evaluate(
        ({ currentDate, nextDate }) => {
          const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
          return {
            current: state.plans?.find((plan: { date: string }) => plan.date === currentDate)?.dailyReminder,
            next: state.plans?.find((plan: { date: string }) => plan.date === nextDate)?.dailyReminder,
          }
        },
        { currentDate, nextDate },
      ),
    )
    .toEqual({ current: 'Keep it concrete', next: 'Keep it concrete' })
})

test('plan items can be nested and un-nested with the drag handle', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const wakeRow = page.getByRole('listitem', { name: /Plan item: Wake up/ })
  const workRow = page.getByRole('listitem', { name: /Plan item: Work block/ })

  await pointerDrag(
    page,
    wakeRow.getByRole('button', { name: 'Drag to move item' }),
    workRow,
    'inside',
  )

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        return Boolean(work?.children?.some((item: { text: string }) => item.text === 'Wake up'))
      }),
    )
    .toBe(true)

  const nestedWakeRow = page.getByRole('listitem', { name: /Plan item: Wake up/ })
  await pointerDrag(
    page,
    nestedWakeRow.getByRole('button', { name: 'Drag to move item' }),
    workRow,
    'before',
  )

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const wakeIsTopLevel = plan?.items?.some((item: { text: string }) => item.text === 'Wake up')
        const wakeIsChild = work?.children?.some((item: { text: string }) => item.text === 'Wake up')
        return Boolean(wakeIsTopLevel && !wakeIsChild)
      }),
    )
    .toBe(true)
})

test('template items can be nested and un-nested with the drag handle', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Templates' }).click()

  const wakeRow = page.getByRole('listitem', { name: /Template item: Wake up/ })
  const workRow = page.getByRole('listitem', { name: /Template item: Work block/ })

  await pointerDrag(
    page,
    wakeRow.getByRole('button', { name: 'Drag to move template item' }),
    workRow,
    'inside',
  )

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Work block')
        return Boolean(work?.children?.some((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Wake up'))
      }),
    )
    .toBe(true)

  const nestedWakeRow = page.getByRole('listitem', { name: /Template item: Wake up/ })
  await pointerDrag(
    page,
    nestedWakeRow.getByRole('button', { name: 'Drag to move template item' }),
    workRow,
    'before',
  )

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Work block')
        const wakeIsTopLevel = template?.items?.some((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Wake up')
        const wakeIsChild = work?.children?.some((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text === 'Wake up')
        return Boolean(wakeIsTopLevel && !wakeIsChild)
      }),
    )
    .toBe(true)
})

test('tab indents a plan item only one level after a nested sibling', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const plan = state.plans?.[0]
    if (!plan) return

    plan.items.push({
      id: 'plan_item_later',
      text: 'Later',
      html: 'Later',
      done: false,
      startMinutes: null,
      endMinutes: null,
      children: [],
    })
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  const topLevelBeforeIndent = await topLevelTexts(page)
  expect(topLevelBeforeIndent).toContain('Later')

  await focusInputByValue(page, 'Later')
  await page.keyboard.press('Tab')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const nestedWrite = work?.children?.find((item: { text: string }) => item.text === 'Write down next action')

        return {
          topLevel: plan?.items?.map((item: { text: string }) => item.text) ?? [],
          workChildren: work?.children?.map((item: { text: string }) => item.text) ?? [],
          writeChildren: nestedWrite?.children?.map((item: { text: string }) => item.text) ?? [],
        }
      }),
    )
    .toEqual({
      topLevel: topLevelBeforeIndent.filter((text) => text !== 'Later'),
      workChildren: ['Pick the first useful task', 'Write down next action', 'Later'],
      writeChildren: [],
    })
})

test('tab indents a template item only one level after a nested sibling', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Templates' }).click()

  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const template = state.templates?.[0]
    if (!template) return

    template.items.push({
      id: 'template_item_later',
      startMinutes: null,
      endMinutes: null,
      options: [
        {
          id: 'option_later',
          text: 'Later',
          html: 'Later',
          probability: 100,
        },
      ],
      children: [],
    })
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  await page.getByRole('button', { name: 'Templates' }).click()
  const topLevelBeforeIndent = await topLevelTemplateOptionTexts(page)
  expect(topLevelBeforeIndent).toContain('Later')

  await focusTemplateOptionByValue(page, 'Later')
  await page.keyboard.press('Tab')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const itemText = (item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text ?? ''
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => itemText(item) === 'Work block')
        const nestedWrite = work?.children?.find(
          (item: { options?: Array<{ text: string }> }) => itemText(item) === 'Write down next action',
        )

        return {
          topLevel: template?.items?.map(itemText) ?? [],
          workChildren: work?.children?.map(itemText) ?? [],
          writeChildren: nestedWrite?.children?.map(itemText) ?? [],
        }
      }),
    )
    .toEqual({
      topLevel: topLevelBeforeIndent.filter((text) => text !== 'Later'),
      workChildren: ['Pick the first useful task', 'Write down next action', 'Later'],
      writeChildren: [],
    })
})

test('shift-tab outdents a plan item without jumping below following siblings', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const topLevelBeforeOutdent = await topLevelTexts(page)
  const workIndex = topLevelBeforeOutdent.indexOf('Work block')
  expect(workIndex).toBeGreaterThanOrEqual(0)

  await focusInputByValue(page, 'Pick the first useful task')
  await page.keyboard.press('Shift+Tab')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const promoted = plan?.items?.find((item: { text: string }) => item.text === 'Pick the first useful task')

        return {
          topLevel: plan?.items?.map((item: { text: string }) => item.text) ?? [],
          workChildren: work?.children?.map((item: { text: string }) => item.text) ?? [],
          promotedChildren: promoted?.children?.map((item: { text: string }) => item.text) ?? [],
        }
      }),
    )
    .toEqual({
      topLevel: [
        ...topLevelBeforeOutdent.slice(0, workIndex + 1),
        'Pick the first useful task',
        ...topLevelBeforeOutdent.slice(workIndex + 1),
      ],
      workChildren: [],
      promotedChildren: ['Write down next action'],
    })
})

test('shift-tab outdents a template item without jumping below following siblings', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Templates' }).click()

  const topLevelBeforeOutdent = await topLevelTemplateOptionTexts(page)
  const workIndex = topLevelBeforeOutdent.indexOf('Work block')
  expect(workIndex).toBeGreaterThanOrEqual(0)

  await focusTemplateOptionByValue(page, 'Pick the first useful task')
  await page.keyboard.press('Shift+Tab')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const itemText = (item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text ?? ''
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => itemText(item) === 'Work block')
        const promoted = template?.items?.find(
          (item: { options?: Array<{ text: string }> }) => itemText(item) === 'Pick the first useful task',
        )

        return {
          topLevel: template?.items?.map(itemText) ?? [],
          workChildren: work?.children?.map(itemText) ?? [],
          promotedChildren: promoted?.children?.map(itemText) ?? [],
        }
      }),
    )
    .toEqual({
      topLevel: [
        ...topLevelBeforeOutdent.slice(0, workIndex + 1),
        'Pick the first useful task',
        ...topLevelBeforeOutdent.slice(workIndex + 1),
      ],
      workChildren: [],
      promotedChildren: ['Write down next action'],
    })
})

test('adding plan time starts after the nearest timed item above', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await page.getByRole('listitem', { name: /Plan item: Wake up/ }).getByRole('button', { name: 'Add time range' }).click()
  await page
    .getByRole('listitem', { name: /Plan item: Pick the first useful task/ })
    .getByRole('button', { name: 'Add time range' })
    .click()
  await page
    .getByRole('listitem', { name: /Plan item: Write down next action/ })
    .getByRole('button', { name: 'Add time range' })
    .click()

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const work = plan?.items?.find((item: { text: string }) => item.text === 'Work block')
        const pick = work?.children?.find((item: { text: string }) => item.text === 'Pick the first useful task')
        const write = work?.children?.find((item: { text: string }) => item.text === 'Write down next action')

        return {
          pick: [pick?.startMinutes, pick?.endMinutes],
          write: [write?.startMinutes, write?.endMinutes],
        }
      }),
    )
    .toEqual({
      pick: [600, 660],
      write: [660, 720],
    })
})

test('adding template time starts after the nearest timed item above', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Templates' }).click()

  await page.getByRole('listitem', { name: /Template item: Wake up/ }).getByRole('button', { name: 'Add time range' }).click()
  await page
    .getByRole('listitem', { name: /Template item: Pick the first useful task/ })
    .getByRole('button', { name: 'Add time range' })
    .click()

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const template = state.templates?.[0]
        const itemText = (item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text ?? ''
        const work = template?.items?.find((item: { options?: Array<{ text: string }> }) => itemText(item) === 'Work block')
        const pick = work?.children?.find((item: { options?: Array<{ text: string }> }) => itemText(item) === 'Pick the first useful task')

        return {
          pick: [pick?.startMinutes, pick?.endMinutes],
        }
      }),
    )
    .toEqual({
      pick: [600, 660],
    })
})

test('plan item text fields support arrow focus and option-arrow sibling moves', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('ArrowDown')

  const focusedAfterDown = await activeInputValue(page)
  expect(focusedAfterDown).not.toBe('Wake up')

  await page.keyboard.press('ArrowUp')
  expect(await activeInputValue(page)).toBe('Wake up')

  await page.keyboard.press('Alt+ArrowDown')
  expect(await activeInputValue(page)).toBe('Wake up')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.plans?.[0]?.items?.[1]?.text
      }),
    )
    .toBe('Wake up')

  await focusInputByValue(page, 'Work block')
  await page.keyboard.press('Alt+ArrowUp')
  expect(await activeInputValue(page)).toBe('Work block')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.[0]
        const workIndex = plan?.items?.findIndex((item: { text: string }) => item.text === 'Work block')
        const work = plan?.items?.[workIndex]
        return {
          workIndex,
          childCount: work?.children?.length,
        }
      }),
    )
    .toEqual({ workIndex: 1, childCount: 2 })
})

test('plan item text fields support left and right boundary focus', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const topLevel = await topLevelTexts(page)
  await focusInputByValue(page, topLevel[0])
  await setCaretOffsetInFocusedEditor(page, topLevel[0].length)
  await page.keyboard.press('ArrowRight')

  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: topLevel[1], caretOffset: 0 })

  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: topLevel[0], caretOffset: topLevel[0].length })

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 'Work block'.length)
  await page.keyboard.press('ArrowRight')

  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: 'Pick the first useful task', caretOffset: 0 })

  await page.keyboard.press('ArrowLeft')
  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
    }))
    .toEqual({ activeText: 'Work block', caretOffset: 'Work block'.length })
})

test('template item text fields support arrow focus and option-arrow sibling moves', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Templates' }).click()

  await focusTemplateOptionByValue(page, 'Wake up')
  await page.keyboard.press('ArrowDown')

  const focusedAfterDown = await activeTemplateOptionValue(page)
  expect(focusedAfterDown).not.toBe('Wake up')

  await page.keyboard.press('ArrowUp')
  expect(await activeTemplateOptionValue(page)).toBe('Wake up')

  const initialOrder = await topLevelTemplateOptionTexts(page)
  const movedOrder = [initialOrder[1], initialOrder[0], ...initialOrder.slice(2)]

  await page.keyboard.press('Alt+ArrowDown')
  expect(await activeTemplateOptionValue(page)).toBe('Wake up')
  await expect.poll(async () => topLevelTemplateOptionTexts(page)).toEqual(movedOrder)

  await page.keyboard.press('Alt+ArrowUp')
  expect(await activeTemplateOptionValue(page)).toBe('Wake up')
  await expect.poll(async () => topLevelTemplateOptionTexts(page)).toEqual(initialOrder)
})

test('cmd d toggles the focused plan item completion state', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  const wakeCheckbox = page.getByRole('listitem', { name: /Plan item: Wake up/ }).getByRole('checkbox')

  await page.keyboard.press('Meta+D')

  await expect(wakeCheckbox).toBeChecked()
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.plans?.[0]?.items?.find((item: { text: string }) => item.text === 'Wake up')?.done
      }),
    )
    .toBe(true)

  await page.keyboard.press('Meta+D')

  await expect(wakeCheckbox).not.toBeChecked()
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.plans?.[0]?.items?.find((item: { text: string }) => item.text === 'Wake up')?.done
      }),
    )
    .toBe(false)
})

test('enter splits plan items and shift-enter inserts a line break', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await setFocusedEditorHTML(page, 'AlphaBeta')
  await setCaretOffsetInFocusedEditor(page, 5)
  await page.keyboard.press('Enter')

  await expect.poll(async () => topLevelTexts(page).then((texts) => texts.slice(0, 2))).toEqual(['Alpha', 'Beta'])
  await expect.poll(async () => activeInputValue(page)).toBe('Beta')
  await expect.poll(async () => topLevelTexts(page).then((texts) => texts.length)).toBe(4)

  await page.keyboard.press('Shift+Enter')
  await expect.poll(async () => storedHTMLForFocusedItem(page)).toContain('<br>')
  await expect.poll(async () => topLevelTexts(page).then((texts) => texts.length)).toBe(4)
})

test('enter at the start of a parent plan item inserts a blank sibling above it', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const items =
          state.plans?.[0]?.items?.map((item: { text: string; children?: Array<{ text: string }> }) => ({
            text: item.text,
            children: item.children?.map((child) => child.text) ?? [],
          })) ?? []
        const workIndex = items.findIndex((item: { text: string }) => item.text === 'Work block')

        return {
          activeText: document.activeElement instanceof HTMLElement ? document.activeElement.textContent : null,
          blankBefore: workIndex > 0 ? items[workIndex - 1] : null,
          workChildren: workIndex >= 0 ? items[workIndex].children : null,
        }
      }),
    )
    .toEqual({
      activeText: '',
      blankBefore: { text: '', children: [] },
      workChildren: ['Pick the first useful task', 'Write down next action'],
    })
})

test('enter in the middle of a parent plan item moves children to the second split item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 4)
  await page.keyboard.press('Enter')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const items =
          state.plans?.[0]?.items?.map((item: { text: string; children?: Array<{ text: string }> }) => ({
            text: item.text,
            children: item.children?.map((child) => child.text) ?? [],
          })) ?? []
        const firstIndex = items.findIndex((item: { text: string }) => item.text === 'Work')

        return {
          activeText: document.activeElement instanceof HTMLElement ? document.activeElement.textContent : null,
          first: firstIndex >= 0 ? items[firstIndex] : null,
          second: firstIndex >= 0 ? items[firstIndex + 1] : null,
        }
      }),
    )
    .toEqual({
      activeText: ' block',
      first: { text: 'Work', children: [] },
      second: { text: ' block', children: ['Pick the first useful task', 'Write down next action'] },
    })
})

test('backspace at the start of a plan item removes an empty item above it', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Enter')
  await focusInputByValue(page, 'Work block')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Backspace')

  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const items =
          state.plans?.[0]?.items?.map((item: { text: string; children?: Array<{ text: string }> }) => ({
            text: item.text,
            children: item.children?.map((child) => child.text) ?? [],
          })) ?? []
        const workIndex = items.findIndex((item: { text: string }) => item.text === 'Work block')

        return {
          activeText: document.activeElement instanceof HTMLElement ? document.activeElement.textContent : null,
          caretOffset: caretOffsetFromDOM(),
          blankBefore: workIndex > 0 ? items[workIndex - 1] : null,
          workChildren: workIndex >= 0 ? items[workIndex].children : null,
        }

        function caretOffsetFromDOM() {
          const active = document.activeElement
          const selection = document.getSelection()
          if (!(active instanceof HTMLElement) || !selection || selection.rangeCount === 0) return null
          const range = selection.getRangeAt(0).cloneRange()
          range.selectNodeContents(active)
          range.setEnd(selection.anchorNode ?? active, selection.anchorOffset)
          return range.toString().length
        }
      }),
    )
    .toEqual({
      activeText: 'Work block',
      caretOffset: 0,
      blankBefore: expect.not.objectContaining({ text: '' }),
      workChildren: ['Pick the first useful task', 'Write down next action'],
    })
})

test('backspace at the start of a plan item merges it into the item above', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  const before = await topLevelTexts(page)
  await focusInputByValue(page, before[1])
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.keyboard.press('Backspace')

  await expect
    .poll(async () => ({
      activeText: await activeInputValue(page),
      caretOffset: await caretOffsetInFocusedEditor(page),
      texts: await topLevelTexts(page),
    }))
    .toEqual({
      activeText: `${before[0]}${before[1]}`,
      caretOffset: before[0].length,
      texts: [`${before[0]}${before[1]}`, ...before.slice(2)],
    })
})

test('plan item rich text preserves paste formatting and supports shortcuts', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are only configured for Chromium in this smoke test')

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5174' })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.evaluate(async () => {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob(['<strong>Bold</strong> <em>Italic</em> <a href="https://example.com">Link</a>'], {
          type: 'text/html',
        }),
        'text/plain': new Blob(['Bold Italic Link'], { type: 'text/plain' }),
      }),
    ])
  })
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => richHTMLForFocusedItem(page))
    .toContain('<strong>Bold</strong> <em>Italic</em> <a href="https://example.com/" target="_blank" rel="noreferrer">Link</a>')

  await setFocusedEditorHTML(page, 'Shortcut')
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+B')
  await expect.poll(async () => richHTMLForFocusedItem(page)).toContain('<b>')
  await expect.poll(async () => storedHTMLForFocusedItem(page)).toContain('<strong>')
  await expect.poll(async () => selectedText(page)).toBe('Shortcut')

  await setFocusedEditorHTML(page, 'Shortcut')
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+I')
  await expect.poll(async () => richHTMLForFocusedItem(page)).toContain('<i>')
  await expect.poll(async () => storedHTMLForFocusedItem(page)).toContain('<em>')
  await expect.poll(async () => selectedText(page)).toBe('Shortcut')

  await page.evaluate(async () => {
    await navigator.clipboard.writeText('https://balance.local')
  })
  await page.evaluate(() => {
    const editor = document.querySelector<HTMLElement>('[data-plan-text-input]')
    if (!editor?.firstChild) return

    const range = document.createRange()
    range.selectNodeContents(editor.firstChild)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  })
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => richHTMLForFocusedItem(page))
    .toContain('<a href="https://balance.local">')
  await expect
    .poll(async () => storedHTMLForFocusedItem(page))
    .toContain('<a href="https://balance.local" target="_blank" rel="noreferrer">')

  await setFocusedEditorHTML(page, '')
  await setCaretOffsetInFocusedEditor(page, 0)
  await page.evaluate(async () => {
    await navigator.clipboard.writeText('https://pasted.local/docs')
  })
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => richHTMLForFocusedItem(page))
    .toContain('<a href="https://pasted.local/docs" target="_blank" rel="noreferrer">https://pasted.local/docs</a>')
  await expect
    .poll(async () => storedHTMLForFocusedItem(page))
    .toContain('<a href="https://pasted.local/docs" target="_blank" rel="noreferrer">https://pasted.local/docs</a>')

  await page.evaluate(() => {
    window.open = (url, target, features) => {
      ;(window as unknown as { openedLink: { url: string; target?: string; features?: string } }).openedLink = {
        url: String(url),
        target: target ?? undefined,
        features: features ?? undefined,
      }
      return null
    }
  })
  await page.locator('[data-plan-text-input] a[href="https://pasted.local/docs"]').click()
  await expect
    .poll(async () =>
      page.evaluate(() => (window as unknown as { openedLink?: { url: string; target?: string; features?: string } }).openedLink),
    )
    .toEqual({
      url: 'https://pasted.local/docs',
      target: '_blank',
      features: 'noopener,noreferrer',
    })
})

test('template options use rich text formatting and generate formatted plan items', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Clipboard permissions are only configured for Chromium in this smoke test')

  await page.context().grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5174' })
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Templates' }).click()

  await focusTemplateOptionByValue(page, 'Wake up')
  await page.evaluate(async () => {
    await navigator.clipboard.write([
      new ClipboardItem({
        'text/html': new Blob(['<strong>Template</strong> <em>Link</em> <a href="https://example.com">Site</a>'], {
          type: 'text/html',
        }),
        'text/plain': new Blob(['Template Link Site'], { type: 'text/plain' }),
      }),
    ])
  })
  await page.keyboard.press('Meta+A')
  await page.keyboard.press('Meta+V')

  await expect
    .poll(async () => richHTMLForFocusedTemplateOption(page))
    .toContain('<strong>Template</strong> <em>Link</em> <a href="https://example.com/" target="_blank" rel="noreferrer">Site</a>')
  await expect
    .poll(async () => storedHTMLForFocusedTemplateOption(page))
    .toContain('<strong>Template</strong> <em>Link</em>')

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()
  await expect.poll(async () => firstPlanItemHTML(page)).toContain('<strong>Template</strong> <em>Link</em>')
})

test('generating from a future date uses the selected date and latest template edits', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.locator('input[type="date"]').fill('2030-01-15')
  await expect(page.getByRole('complementary').getByRole('button', { name: 'Generate selected day' })).toBeVisible()

  await page.getByRole('button', { name: 'Templates' }).click()
  await focusTemplateOptionByValue(page, 'Wake up')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('Future plan item')
  await expect.poll(async () => storedTextForFocusedTemplateOption(page)).toBe('Future plan item')

  await page.getByRole('complementary').getByRole('button', { name: 'Generate selected day' }).click()

  await expect(page.locator('input[type="date"]')).toHaveValue('2030-01-15')
  await expect
    .poll(async () =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        const plan = state.plans?.find((candidate: { date: string }) => candidate.date === '2030-01-15')
        return plan?.items?.[0]?.text ?? null
      }),
    )
    .toBe('Future plan item')
})

test('blank template options show skip placeholder and skip generated plan item', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('button', { name: 'Templates' }).click()

  const wakeRow = page.getByRole('listitem', { name: /Template item: Wake up/ })
  await wakeRow.getByRole('button', { name: '±' }).click()
  await expect
    .poll(async () =>
      wakeRow.locator('[data-template-option-text-input]').nth(1).evaluate((input) => input.getAttribute('data-placeholder')),
    )
    .toBe('(Skip)')

  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const firstItem = state.templates?.[0]?.items?.[0]
    const firstOption = firstItem?.options?.[0]
    if (!firstItem || !firstOption) return

    firstItem.options = [
      {
        ...firstOption,
        text: '',
        html: '',
        probability: 100,
      },
    ]
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await expect.poll(async () => topLevelTexts(page)).not.toContain('Wake up')
  await expect.poll(async () => topLevelTexts(page)).not.toContain('')
})

test('typing in rich plan item text keeps the caret at the insertion point', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('abc')

  await expect.poll(async () => activeInputValue(page)).toBe('abc')
  await expect.poll(async () => caretOffsetInFocusedEditor(page)).toBe(3)
})

test('global undo and redo batch text edits', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('Meta+A')
  await page.keyboard.type('abc')
  await expect.poll(async () => activeInputValue(page)).toBe('abc')

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => activeInputValue(page)).toBe('Wake up')

  await page.keyboard.press('Meta+Shift+Z')
  await expect.poll(async () => activeInputValue(page)).toBe('abc')

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => activeInputValue(page)).toBe('Wake up')

  await page.keyboard.press('Meta+Shift+C')
  await expect.poll(async () => activeInputValue(page)).toBe('abc')
})

test('global undo and redo apply to item movement', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const initialOrder = await topLevelTexts(page)
  const movedOrder = [initialOrder[1], initialOrder[0], ...initialOrder.slice(2)]

  await focusInputByValue(page, 'Wake up')
  await page.keyboard.press('Alt+ArrowDown')
  await expect.poll(async () => topLevelTexts(page)).toEqual(movedOrder)

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => topLevelTexts(page)).toEqual(initialOrder)

  await page.keyboard.press('Meta+Shift+Z')
  await expect.poll(async () => topLevelTexts(page)).toEqual(movedOrder)

  await page.keyboard.press('Meta+Z')
  await expect.poll(async () => topLevelTexts(page)).toEqual(initialOrder)

  await page.keyboard.press('Meta+Shift+C')
  await expect.poll(async () => topLevelTexts(page)).toEqual(movedOrder)
})

async function focusInputByValue(page: import('@playwright/test').Page, value: string) {
  await page.evaluate((expectedValue) => {
    const input = Array.from(document.querySelectorAll<HTMLElement>('[data-plan-text-input]')).find(
      (candidate) => candidate.textContent === expectedValue,
    )
    input?.focus()
  }, value)
}

async function activeInputValue(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.matches('[data-plan-text-input]') ? active.textContent : null
  })
}

async function setFocusedEditorHTML(page: import('@playwright/test').Page, html: string) {
  await page.evaluate((nextHTML) => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-plan-text-input]')) return
    active.innerHTML = nextHTML
    active.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  }, html)
}

async function setCaretOffsetInFocusedEditor(page: import('@playwright/test').Page, offset: number) {
  await page.evaluate((targetOffset) => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-plan-text-input]')) return

    const walker = document.createTreeWalker(active, NodeFilter.SHOW_TEXT)
    let remaining = targetOffset
    let targetNode: Node = active
    let nodeOffset = 0
    let node = walker.nextNode()

    while (node) {
      const length = node.textContent?.length ?? 0
      if (remaining <= length) {
        targetNode = node
        nodeOffset = remaining
        break
      }
      remaining -= length
      node = walker.nextNode()
    }

    if (!node) {
      targetNode = active
      nodeOffset = active.childNodes.length
    }

    const range = document.createRange()
    range.setStart(targetNode, nodeOffset)
    range.collapse(true)

    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }, offset)
}

async function richHTMLForFocusedItem(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.matches('[data-plan-text-input]') ? active.innerHTML : null
  })
}

async function storedHTMLForFocusedItem(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-plan-text-input]')) return null

    const itemId = active.dataset.planTextInputId
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const findItem = (items: Array<{ id: string; html: string; children?: unknown[] }>): string | null => {
      for (const item of items) {
        if (item.id === itemId) return item.html
        const childHTML = findItem((item.children ?? []) as Array<{ id: string; html: string; children?: unknown[] }>)
        if (childHTML !== null) return childHTML
      }
      return null
    }

    return findItem(state.plans?.[0]?.items ?? [])
  })
}

async function focusTemplateOptionByValue(page: import('@playwright/test').Page, value: string) {
  await page.evaluate((expectedValue) => {
    const input = Array.from(document.querySelectorAll<HTMLElement>('[data-template-option-text-input]')).find(
      (candidate) => candidate.textContent === expectedValue,
    )
    input?.focus()
  }, value)
}

async function activeTemplateOptionValue(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.matches('[data-template-option-text-input]') ? active.textContent : null
  })
}

async function richHTMLForFocusedTemplateOption(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    return active instanceof HTMLElement && active.matches('[data-template-option-text-input]') ? active.innerHTML : null
  })
}

async function storedHTMLForFocusedTemplateOption(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-template-option-text-input]')) return null

    const optionId = active.dataset.templateOptionTextInputId
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const findOption = (
      items: Array<{ options?: Array<{ id: string; html: string }>; children?: unknown[] }>,
    ): string | null => {
      for (const item of items) {
        const option = item.options?.find((candidate) => candidate.id === optionId)
        if (option) return option.html
        const childHTML = findOption((item.children ?? []) as Array<{ options?: Array<{ id: string; html: string }>; children?: unknown[] }>)
        if (childHTML !== null) return childHTML
      }
      return null
    }

    return findOption(state.templates?.[0]?.items ?? [])
  })
}

async function storedTextForFocusedTemplateOption(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    if (!(active instanceof HTMLElement) || !active.matches('[data-template-option-text-input]')) return null

    const optionId = active.dataset.templateOptionTextInputId
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    const findOption = (
      items: Array<{ options?: Array<{ id: string; text: string }>; children?: unknown[] }>,
    ): string | null => {
      for (const item of items) {
        const option = item.options?.find((candidate) => candidate.id === optionId)
        if (option) return option.text
        const childText = findOption((item.children ?? []) as Array<{ options?: Array<{ id: string; text: string }>; children?: unknown[] }>)
        if (childText !== null) return childText
      }
      return null
    }

    return findOption(state.templates?.[0]?.items ?? [])
  })
}

async function firstPlanItemHTML(page: import('@playwright/test').Page) {
  return page.evaluate(() => document.querySelector<HTMLElement>('[data-plan-text-input]')?.innerHTML ?? null)
}

async function selectedText(page: import('@playwright/test').Page) {
  return page.evaluate(() => document.getSelection()?.toString() ?? '')
}

async function caretOffsetInFocusedEditor(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const active = document.activeElement
    const selection = document.getSelection()
    if (!(active instanceof HTMLElement) || !active.matches('[data-plan-text-input]') || !selection || selection.rangeCount === 0) {
      return null
    }

    const range = selection.getRangeAt(0).cloneRange()
    range.selectNodeContents(active)
    range.setEnd(selection.anchorNode ?? active, selection.anchorOffset)
    return range.toString().length
  })
}

async function topLevelTexts(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.plans?.[0]?.items?.map((item: { text: string }) => item.text) ?? []
  })
}

async function topLevelTemplateOptionTexts(page: import('@playwright/test').Page) {
  return page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.templates?.[0]?.items?.map((item: { options?: Array<{ text: string }> }) => item.options?.[0]?.text ?? '') ?? []
  })
}

function addDays(date: string, days: number) {
  const parsed = new Date(`${date}T12:00:00`)
  parsed.setDate(parsed.getDate() + days)
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

async function pointerDrag(
  page: import('@playwright/test').Page,
  source: import('@playwright/test').Locator,
  target: import('@playwright/test').Locator,
  placement: 'before' | 'inside' | 'after',
) {
  const sourceBox = await source.boundingBox()
  const targetBox = await target.boundingBox()
  if (!sourceBox || !targetBox) throw new Error('Missing drag geometry')

  const targetY =
    placement === 'before'
      ? targetBox.y + 3
      : placement === 'after'
        ? targetBox.y + targetBox.height - 3
        : targetBox.y + targetBox.height / 2

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + Math.min(160, targetBox.width / 2), targetY, { steps: 8 })
  await page.mouse.up()
}
