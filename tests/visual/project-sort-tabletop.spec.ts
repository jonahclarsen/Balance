import { expect, test, type Page } from '@playwright/test'
import { openView } from '../helpers/navigation'

async function add(page: Page, title: string) {
  await page.getByRole('textbox', { name: 'New project name' }).fill(title)
  await page.getByRole('button', { name: 'Add', exact: true }).click()
}

test('hover cuts the paper, undo restores the whole stroke, the last slip releases itself, and start over is undoable', async ({
  page,
}) => {
  await page.goto('/')
  await openView(page, 'Projects')
  await add(page, 'Synthetic orchard')
  await add(page, 'Paper cranes')
  await page.getByRole('button', { name: 'Sort', exact: true }).click()
  const canvas = page.getByLabel('Project sort tabletop')
  await expect(page.getByText('0 / 2 cut')).toBeVisible()
  const box = (await canvas.boundingBox())!
  const { width, height } = await canvas.evaluate((c) => ({ width: c.clientWidth, height: c.clientHeight }))
  const ratio = box.width / width,
    scale = Math.min((width - 38) / 570, 1.28) * ratio
  const y = box.y + (height < 365 ? 60 : 88) * ratio
  const x = box.x + (box.width - 570 * scale) / 2 + 280 * scale
  await page.mouse.move(x, y - 8)
  await page.mouse.move(x, y + 80 * scale, { steps: 18 })
  await page.mouse.move(box.x + (box.width - 570 * scale) / 2 - 9, y + 82 * scale, { steps: 28 })
  await expect(page.getByText('0 / 2 placed')).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(page.getByText('0 / 2 cut')).toBeVisible()
  await canvas.focus()
  await page.keyboard.press('Space')
  await expect(page.getByText('0 / 2 placed')).toBeVisible()
  const startOver = page.getByRole('button', { name: 'Start over' })
  await startOver.click()
  await expect(page.getByText('0 / 2 cut')).toBeVisible()
  await expect(startOver).toBeDisabled()
  await page.getByRole('button', { name: 'Undo' }).click()
  await expect(page.getByText('0 / 2 placed')).toBeVisible()
})

test('a singleton starts in the pile, a new title returns to cutting, and history reopens a frozen snapshot', async ({
  page,
}) => {
  await page.goto('/')
  await openView(page, 'Projects')
  await add(page, 'Synthetic studio')
  const sort = page.getByRole('button', { name: 'Sort', exact: true })
  await sort.click()
  const canvas = page.getByLabel('Project sort tabletop')
  await expect(page.getByText('0 / 1 placed')).toBeVisible()
  const box = (await canvas.boundingBox())!
  const { width, height } = await canvas.evaluate((c) => ({ width: c.clientWidth, height: c.clientHeight }))
  const ratio = box.width / width
  await page.mouse.move(
    box.x + (width < 510 ? Math.min(74, width * 0.24) : 99) * ratio,
    box.y + (height < 365 ? 30 : 40) * ratio,
  )
  await page.mouse.down()
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.62, { steps: 12 })
  await page.mouse.up()
  await expect(page.getByText('1 / 1 placed')).toBeVisible()
  await page.getByRole('button', { name: 'Back to Projects' }).click()
  await add(page, 'A long synthetic project title that wraps over several handwritten lines')
  await sort.click()
  await expect(page.getByText('1 / 2 cut')).toBeVisible()
  await canvas.focus()
  await page.keyboard.press('Space')
  await expect(page.getByText('1 / 2 placed')).toBeVisible()
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('heading', { name: 'Saved tabletop' })).toBeVisible()
  await page.getByRole('button', { name: 'Copy to history' }).click()
  await page.getByRole('button', { name: 'Back to Projects' }).click()
  await add(page, 'After saving')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const link = page.locator('a.history-sort-link')
  await expect(link).toHaveCount(1)
  expect(await link.evaluate((el) => getComputedStyle(el, '::after').backgroundImage)).toContain(
    'data:image/jpeg;base64,',
  )
  await link.click()
  await expect(page.getByRole('heading', { name: 'Saved tabletop' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Project slips' }).getByRole('listitem')).toHaveCount(2)
})

test('Wii Sports leaves room for the complete Projects search shortcut', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId: 'wiisports' }))
  })
  await page.goto('/')
  await openView(page, 'Projects')
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'wiisports')
  const field = page.getByRole('searchbox', { name: 'Search projects' })
  await expect.poll(() => field.evaluate(async node => {
    await document.fonts.ready
    const input = node as HTMLInputElement
    const style = getComputedStyle(input)
    const placeholder = getComputedStyle(input, '::placeholder')
    const ctx = document.createElement('canvas').getContext('2d')!
    ctx.font = placeholder.font || style.font
    const remaining = input.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
    return remaining >= ctx.measureText(input.placeholder).width + 12
  })).toBe(true)
})

test('saved sorts from the original version still open and link to Project History', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(async () => {
    const plannerPath = '/src/lib/planner.ts'
    const { createInitialState } = await import(/* @vite-ignore */ plannerPath)
    const date = '2026-11-20T12:00:00.000Z'
    localStorage.setItem('balance.appState.v1', JSON.stringify({
      ...createInitialState(),
      projectSorts: [{
        id: 'legacy-tabletop',
        startedAt: date,
        saved: true,
        titles: [{ id: 'project-garden', name: 'Synthetic garden' }],
        slips: [{ id: 'project-garden', rows: [[1, 10, 84], [1, 11, 84]], center: { x: 45, y: 11 }, place: { x: 0.5, y: 0.55 } }],
        cuts: [],
        preview: 'data:image/webp;base64,c3ludGhldGlj',
      }],
      projectHistoryNotes: [{
        id: 'project-history-backstory',
        items: [{ id: 'legacy-link', kind: 'paragraph', text: 'Old tabletop', html: '<a href="balance://project-sort/legacy-tabletop">Old tabletop</a>', children: [] }],
        createdAt: date,
        updatedAt: date,
      }],
    }))
  })
  await page.reload()
  await openView(page, 'Projects')
  await page.getByRole('button', { name: 'History', exact: true }).click()
  const link = page.locator('a.history-sort-link').filter({ hasText: 'Old tabletop' })
  await link.click()
  await expect(page.getByRole('heading', { name: 'Saved tabletop' })).toBeVisible()
  await expect(page.getByRole('list', { name: 'Project slips' })).toContainText('Synthetic garden')
  await page.getByRole('button', { name: 'Copy to history' }).click()
  await page.getByRole('button', { name: 'Back to Projects' }).click()
  await page.getByRole('button', { name: 'History', exact: true }).click()
  await expect(page.locator('a.history-sort-link')).toHaveCount(2)
})
