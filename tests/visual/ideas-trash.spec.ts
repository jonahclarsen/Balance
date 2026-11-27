import { expect, test, type Page } from '@playwright/test'
import { openView, skipCalendarCheck } from '../helpers/navigation'

test.beforeEach(({ page }) => skipCalendarCheck(page))
test.use({ timezoneId: 'America/Vancouver' })

const NOW = new Date('2026-10-08T18:00:00Z')

const card = (page: Page, kind: string) => page.locator(`.idea-group-card[data-idea-group="${kind}"]`)
const pane = (page: Page, kind: string) => page.locator(`.idea-group-pane[data-idea-pane="${kind}"]`)
const rows = (page: Page, kind: string) => pane(page, kind).locator('[data-plan-text-input]')

test('large Ideas Trash switches with only nearby editors mounted', async ({ page }, testInfo) => {
  // Freeze Date for Trash retention while keeping the frame timings real.
  await page.clock.setFixedTime(NOW)
  await page.goto('/')
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()

  const total = 1_200
  const { lastId, childId } = await page.evaluate(async (total) => {
    const storePath = '/src/lib/store.ts'
    const plannerPath = '/src/lib/planner.ts'
    const { plannerStore } = await import(/* @vite-ignore */ storePath) as typeof import('../../src/lib/store')
    const { createPlanItem } = await import(/* @vite-ignore */ plannerPath) as typeof import('../../src/lib/planner')
    const items = Array.from({ length: total }, (_, index) => {
      const text = 'Discarded idea ' + (index + 1)
      return { ...createPlanItem(text), html: '<strong>' + text + '</strong>' }
    })
    items[total - 1]!.children.push(createPlanItem('Nested discarded idea'))
    const ids = plannerStore.importIdeas(items, 'trash')
    const lastId = ids[total - 1]!
    let childId = ''
    plannerStore.subscribe((state) => {
      const last = state.ideaBuckets.find((group) => group.kind === 'trash')!.items[total - 1]!
      childId = last.children[0]!.id
    })()
    plannerStore.addIdea('balance://task/' + childId)
    return { lastId, childId }
  }, total)
  await openView(page, 'Ideas')
  await expect(card(page, 'trash').locator('.idea-group-count')).toHaveText(String(total))

  const measurements = await page.evaluate(async () => {
    const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    const samples = []
    for (const kind of ['trash', 'proposition', 'trash', 'proposition', 'trash', 'proposition']) {
      const tab = document.querySelector<HTMLButtonElement>(`.idea-group-card[data-idea-group="${kind}"]`)!
      const start = performance.now()
      tab.click()
      await frame()
      await frame()
      samples.push({
        kind,
        ms: Math.round(performance.now() - start),
        editors: document.querySelectorAll('.idea-group-list [data-plan-text-input]').length,
      })
    }
    return samples
  })
  console.log('Large Ideas Trash switch timings:', JSON.stringify(measurements))
  await testInfo.attach('ideas-trash-switches', { body: JSON.stringify(measurements), contentType: 'application/json' })
  for (const sample of measurements) {
    expect(sample.editors).toBeGreaterThan(0)
    expect(sample.editors).toBeLessThan(sample.kind === 'trash' ? total / 10 : 2)
  }

  await card(page, 'trash').click()
  const first = rows(page, 'trash').filter({ hasText: /^Discarded idea 1$/ })
  await expect(first).toBeInViewport()
  await first.click()
  await expect(first).toBeFocused()
  const last = pane(page, 'trash').locator(`[data-plan-item-id="${lastId}"]`)
  await expect(last).toHaveCount(0)

  // Jump to the end and use the normal Add item control there.
  const add = pane(page, 'trash').getByRole('button', { name: '+ Add item' })
  await add.scrollIntoViewIfNeeded()
  await expect(last).toBeInViewport()
  await expect(first).toBeFocused()
  await add.click()
  await expect(first).toHaveCount(0)
  const added = pane(page, 'trash').locator('[data-plan-text-input]:focus')
  await expect(added).toHaveCount(1)
  await added.fill('Discarded draft')

  // An internal link can also reveal an offscreen idea's subtask.
  await card(page, 'proposition').click()
  await pane(page, 'proposition').getByRole('link', { name: `balance://task/${childId}` }).click()
  const child = pane(page, 'trash').locator(`[data-plan-item-id="${childId}"]`)
  await expect(child).toHaveClass(/search-result-target/)
  await expect(child).toBeInViewport()
  await expect(pane(page, 'trash').getByText('Discarded draft', { exact: true })).toBeVisible()
})
