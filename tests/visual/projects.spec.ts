import { expect, test, type Page } from '@playwright/test'

async function openView(page: Page, name: string) {
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name, exact: true }).click()
}

test('project check-ins retain history, survive reload, and open from a planner link', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.keyboard.press('Alt+p')
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
  await page.getByRole('textbox', { name: 'New project name' }).fill('Synthetic garden')
  await page.getByRole('button', { name: 'Add project', exact: true }).click()
  const card = page.locator('.project-card')
  await expect(card).toHaveCount(1)
  await expect(card.getByRole('slider')).toHaveCount(0)
  await expect(card.locator('dd')).toHaveText(['Not set', 'Not set'])
  await page.getByRole('button', { name: 'Check in', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Save check-in' })).toBeDisabled()
  await expect(card.locator('.probability-slider')).toHaveCount(2)
  const initialTracks = await card.locator('.track-wrap').evaluateAll((tracks) => tracks.map((track) => {
    const rect = track.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width }
  }))
  await page.getByRole('slider', { name: 'Work complete for Synthetic garden' }).fill('35')
  await expect(page.getByRole('button', { name: 'Save check-in' })).toBeDisabled()
  const mixedTracks = await card.locator('.track-wrap').evaluateAll((tracks) => tracks.map((track) => {
    const rect = track.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width }
  }))
  expect(mixedTracks).toEqual(initialTracks)
  expect(Math.abs(mixedTracks[0].width - mixedTracks[1].width)).toBeLessThan(1)
  expect(mixedTracks[0].y).toBe(mixedTracks[1].y)
  await page.screenshot({ path: test.info().outputPath('project-check-in.png'), fullPage: true, animations: 'disabled' })
  await page.getByRole('slider', { name: 'Heart in it for Synthetic garden' }).fill('80')
  await page.getByRole('button', { name: 'Save check-in' }).click()
  await expect(card.locator('summary')).toContainText('1 check-in')
  const persistedAction = await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let operation: any
    const unsubscribe = plannerStore.subscribe((state: any) => { operation = state.operations.at(-1) })
    unsubscribe()
    return operation
  })
  expect(persistedAction.type).toBe('apply_entity_changes')
  expect(persistedAction.payload.action).toBe('check_in_project')
  expect(persistedAction.payload.entityChanges.version).toBe(2)
  expect(persistedAction.payload.entityChanges.upserts.some((row: any) => row.collection === 'projectCheckIns')).toBe(true)

  await expect(card.getByRole('slider')).toHaveCount(0)
  await page.getByRole('button', { name: 'Check in', exact: true }).click()
  await page.getByRole('slider', { name: 'Work complete for Synthetic garden' }).fill('95')
  await page.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(card.locator('dd')).toHaveText(['35%', '80%'])
  await page.getByRole('button', { name: 'Check in', exact: true }).click()
  await page.getByRole('slider', { name: 'Work complete for Synthetic garden' }).fill('50')
  await page.getByRole('slider', { name: 'Heart in it for Synthetic garden' }).fill('60')
  await page.getByRole('button', { name: 'Save check-in' }).click()
  await card.locator('summary').click()
  await expect(card.locator('tbody tr')).toHaveCount(2)
  await expect(card.locator('tbody tr').last()).toContainText('35%')
  await expect(card.locator('tbody tr').last()).toContainText('80%')
  await page.reload()
  await openView(page, 'Projects')
  await expect(card.getByRole('slider')).toHaveCount(0)
  await expect(card.locator('dd')).toHaveText(['50%', '60%'])
  await page.screenshot({ path: test.info().outputPath('project-vibes.png'), fullPage: true, animations: 'disabled' })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.getByRole('button', { name: 'Copy page link' }).click()
  await expect(page.locator('.projects-panel .status')).toContainText(/Link copied|balance:\/\/projects/)
  await page.getByRole('button', { name: 'Edit details' }).click()
  await expect(card.locator('input[type=color]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Archive project', exact: true }).click()
  await expect(card).toHaveCount(0)
  await page.getByRole('button', { name: 'View Archive' }).click()
  await expect(page.locator('#project-archive')).toContainText('Synthetic garden')
  // Reload with a synthetic linked task; no installed application data is used.
  await page.evaluate(() => {
    const key = 'balance.appState.v1'
    const state = JSON.parse(localStorage.getItem(key)!)
    const projectId = state.projects[0].id
    const now = new Date()
    const date = state.activePlanDate
    const plan = { id: 'project-link-plan', date, title: 'Synthetic day', dailyReminder: '', generatedFromTemplateId: null, createdAt: now.toISOString(), items: [] as unknown[] }
    state.plans = [plan]
    plan.items = [{ id: 'project-link-test', text: `balance://projects/${projectId}`, html: `balance://projects/${projectId}`, done: false, children: [], time: '', endTime: '' }]
    localStorage.setItem(key, JSON.stringify(state))
  })
  await page.reload()
  const link = page.locator('[data-internal-link-kind="projects"]').first()
  await expect(link).toBeVisible()
  await link.click()
  await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
  await expect(card).toHaveClass(/highlighted/)
  await expect(card).toContainText('Archived')
  await page.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect(card.locator('dd')).toHaveText(['50%', '60%'])
  await page.getByRole('button', { name: 'Edit details' }).click()
  await expect(card.locator('input[type=color]')).toHaveCount(0)
  await page.getByRole('button', { name: 'Archive project', exact: true }).click()
  page.once('dialog', (dialog) => dialog.dismiss())
  await page.getByRole('button', { name: 'Delete forever' }).click()
  await expect(page.locator('#project-archive')).toContainText('Synthetic garden')
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete forever' }).click()
  await expect(page.locator('#project-archive')).not.toContainText('Synthetic garden')
  const persisted = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!))
  expect(persisted.projects).toEqual([])
  expect(persisted.projectCheckIns).toEqual([])
})

for (const destination of ['page', 'project'] as const) {
  test(`pasting a ${destination} link over selected template text preserves the label`, async ({ page }) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    await openView(page, 'Projects')
    await page.getByRole('textbox', { name: 'New project name' }).fill('Synthetic garden')
    await page.getByRole('button', { name: 'Add project', exact: true }).click()
    const projectId = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).projects[0].id)
    const url = destination === 'page' ? 'balance://projects' : `balance://projects/${projectId}`
    await openView(page, 'Lists')
    await page.getByRole('button', { name: '+ New list', exact: true }).click()
    const editor = page.locator('[data-list-template-text-input]').first()
    await editor.fill('Review my projects today')
    await editor.evaluate((element, link) => {
      element.focus()
      const range = document.createRange()
      range.setStart(element.firstChild!, 7)
      range.setEnd(element.firstChild!, 18)
      const selection = document.getSelection()!
      selection.removeAllRanges()
      selection.addRange(range)
      const clipboard = new DataTransfer()
      clipboard.setData('text/plain', link)
      element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: clipboard }))
    }, url)
    await editor.blur()
    await expect(editor).toHaveText('Review my projects today')
    await expect(editor.getByRole('link', { name: 'my projects' })).toHaveAttribute('href', url)
    await page.reload()
    await openView(page, 'Lists')
    await expect(editor).toHaveText('Review my projects today')
    const link = editor.getByRole('link', { name: 'my projects' })
    await expect(link).toHaveAttribute('href', url)
    await link.click()
    await expect(page.getByRole('heading', { name: 'Projects', exact: true })).toBeVisible()
    if (destination === 'project') await expect(page.locator('.project-card')).toHaveClass(/highlighted/)
  })
}
