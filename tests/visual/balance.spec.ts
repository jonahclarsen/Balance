import { expect, test } from '@playwright/test'

test('core planner screens render and screenshot cleanly', async ({ page }, testInfo) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await expect(page.getByRole('heading', { name: 'Balance' })).toBeVisible()
  const generateButton = page.getByRole('complementary').getByRole('button', { name: 'Generate today' })
  await expect(generateButton).toBeVisible()

  await generateButton.click()
  await expect(page.getByPlaceholder('Plan item').first()).toBeVisible()
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
