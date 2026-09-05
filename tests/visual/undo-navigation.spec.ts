import { expect, test } from '@playwright/test'

test('undo opens the sidebar page that owns the restored change', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Keyboard undo navigation is covered by the desktop project')

  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  const planItem = page.locator('[data-plan-text-input]').first()
  await planItem.fill('Restored on Today')
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.operations?.at(-1)?.type
  })).toBe('patch_plan_item')
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Notes', exact: true }).first()).toBeVisible()

  await dispatchUndo(page)

  await expect(page.getByRole('button', { name: 'Today', exact: true })).toHaveClass(/active/)
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await expect(page.locator('[data-plan-text-input]').first()).toHaveText('Wake up')

  await page.getByRole('button', { name: 'Lists', exact: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  await page.getByLabel('List name').fill('Undo destination')
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
    return state.operations?.at(-1)?.type
  })).toBe('rename_list_template')
  await page.getByRole('button', { name: 'Goals', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Goals', exact: true })).toBeVisible()

  await dispatchUndo(page)

  await expect(page.getByRole('button', { name: 'Lists', exact: true })).toHaveClass(/active/)
  await expect(page.getByRole('heading', { name: 'Lists', exact: true })).toBeVisible()
  await expect(page.getByLabel('List name')).toHaveValue('New list')
})

async function dispatchUndo(page: import('@playwright/test').Page) {
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z',
    code: 'KeyZ',
    metaKey: true,
    bubbles: true,
    cancelable: true,
  })))
}

async function storeAction(page: import('@playwright/test').Page, action: 'seed' | 'edit' | 'navigate' | 'add' | 'undo' | 'redo') {
  return page.evaluate(async (action) => {
    const modulePath = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ modulePath)
    let state: any
    const stop = plannerStore.subscribe((value: any) => { state = value })
    await plannerStore.ready
    if (action === 'seed') {
      plannerStore.generatePlan(state.templates[0].id, '2026-08-20', true)
      for (let index = 0; index < 35; index++) plannerStore.addRootPlanItem(state.plans[0].id)
    } else if (action === 'edit') {
      const plan = state.plans.find((plan: any) => plan.date === '2026-08-20')
      plannerStore.patchPlanItem(plan.id, plan.items[0].id, { text: 'History target', html: 'History target' })
    } else if (action === 'add') {
      plannerStore.addRootPlanItem(state.plans[0].id)
    } else if (action === 'navigate') plannerStore.setActivePlanDate('2026-08-21')
    else await plannerStore[action]()
    const result = { sequence: state.localSequence, operations: state.operations.length, date: state.activePlanDate, firstItem: state.plans[0]?.items[0]?.id }
    stop()
    return result
  }, action)
}

async function openPage(page: import('@playwright/test').Page, name: string) {
  const drawer = page.getByRole('button', { name: 'Open navigation' })
  if (await drawer.isVisible()) await drawer.click()
  await page.getByRole('button', { name, exact: true }).click()
}

async function dispatchRedo(page: import('@playwright/test').Page) {
  await page.evaluate(() => window.dispatchEvent(new KeyboardEvent('keydown', {
    key: 'z', code: 'KeyZ', metaKey: true, shiftKey: true, bubbles: true, cancelable: true,
  })))
}

test('day navigation stays local, preserves redo, and survives reload', async ({ page }) => {
  await page.goto('/')
  await storeAction(page, 'seed')
  await storeAction(page, 'edit')
  const before = await storeAction(page, 'undo')
  const navigated = await storeAction(page, 'navigate')
  expect(navigated.sequence).toBe(before.sequence)
  expect(navigated.operations).toBe(before.operations)
  await storeAction(page, 'redo')
  await expect(page.getByLabel('Day date', { exact: true })).toHaveValue('2026-08-21')
  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    return { date: state.activePlanDate, navigationOps: state.operations.filter((op: any) => op.type === 'set_active_plan_date').length }
  })).toEqual({ date: '2026-08-21', navigationOps: 0 })
  await page.reload()
  await expect(page.getByLabel('Day date', { exact: true })).toHaveValue('2026-08-21')
})

test('undo and redo return to the changed date and highlight the exact item across pages', async ({ page }) => {
  await page.goto('/')
  const { firstItem } = await storeAction(page, 'seed')
  await storeAction(page, 'edit')
  await storeAction(page, 'navigate')
  await openPage(page, 'Notes')
  await dispatchUndo(page)
  await expect(page.getByLabel('Day date', { exact: true })).toHaveValue('2026-08-20')
  const row = page.locator(`[data-plan-item-id="${firstItem}"]`)
  await expect(row).toHaveClass(/search-result-target/)
  await expect(row).toBeInViewport()
  await expect(page.locator('.history-notice')).toContainText('Undid item change · 2026-08-20')
  await storeAction(page, 'navigate')
  await openPage(page, 'Notes')
  await dispatchRedo(page)
  await expect(page.getByLabel('Day date', { exact: true })).toHaveValue('2026-08-20')
  await expect(row).toContainText('History target')
  await expect(row).toBeInViewport()
  await expect(page.locator('.history-notice')).toContainText('Redid item change')
})

test('undo reveals an offscreen row and highlights the list when an added row disappears', async ({ page }) => {
  await page.goto('/')
  const { firstItem } = await storeAction(page, 'seed')
  await storeAction(page, 'edit')
  await page.locator('[data-plan-item-id]').last().scrollIntoViewIfNeeded()
  const row = page.locator(`[data-plan-item-id="${firstItem}"]`)
  await expect(row).not.toBeInViewport()
  await dispatchUndo(page)
  await expect(row).toBeInViewport()
  await expect(row).toHaveClass(/search-result-target/)
  await storeAction(page, 'add')
  const count = await page.locator('[data-plan-item-id]').count()
  await dispatchUndo(page)
  await expect(page.locator('[data-plan-item-id]')).toHaveCount(count - 1)
  await expect(page.locator('.search-result-target').last()).toBeInViewport()
})

for (const surface of ['notes', 'lists', 'metrics'] as const) {
  test(`undo reveals the changed ${surface} document or dated answer`, async ({ page }) => {
    await page.goto('/')
    await page.evaluate(async (surface) => {
      const modulePath = '/src/lib/store.ts'
      const { plannerStore: store } = await import(/* @vite-ignore */ modulePath)
      await store.ready
      let state: any
      const stop = store.subscribe((value: any) => { state = value })
      if (surface === 'notes') {
        const id = store.addNote()
        store.renameNote(id, 'Original document')
        store.renameNote(id, 'Changed document')
      } else if (surface === 'lists') {
        const id = store.addListTemplate()
        store.renameListTemplate(id, 'Changed list')
      } else {
        const id = store.addMetric()
        store.addMetricQuestion(id)
        const metric = state.metrics.find((metric: any) => metric.id === id)
        const question = metric.questions.at(-1)
        store.patchMetricQuestion(id, question.id, { prompt: 'Second question', type: 'text' })
        store.upsertMetricAnswer(id, '2026-08-19', question.id, 'Saved answer')
      }
      stop()
    }, surface)
    await dispatchUndo(page)
    if (surface === 'notes') {
      await expect(page.getByLabel('Note title')).toBeVisible()
      await expect(page.locator('.note-document')).toHaveClass(/search-result-target/)
    } else if (surface === 'lists') {
      await expect(page.getByLabel('List name')).toHaveValue('New list')
      await expect(page.locator('.template-panel')).toHaveClass(/search-result-target/)
    } else {
      await expect(page.locator('.metric-quiz')).toHaveClass(/search-result-target/)
      await expect(page.locator('.metric-prompt')).toHaveText('Second question')
      await expect(page.locator('.metric-text-input')).toHaveValue('')
      await dispatchRedo(page)
      await expect(page.locator('.metric-text-input')).toHaveValue('Saved answer')
      await expect(page.locator('.history-notice')).toContainText('2026-08-19')
    }
  })
}
