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
