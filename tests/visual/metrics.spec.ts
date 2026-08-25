import { expect, test, type Locator, type Page } from '@playwright/test'

async function dragQuestionBefore(page: Page, handle: Locator, target: Locator) {
  const handleBox = await handle.boundingBox()
  const targetBox = await target.boundingBox()
  if (!handleBox || !targetBox) throw new Error('Expected the question handle and target row to be visible')

  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2)
  await page.mouse.down()
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height / 2, { steps: 8 })
  await page.mouse.move(targetBox.x + targetBox.width / 2, targetBox.y + targetBox.height * 0.15, { steps: 4 })
  await page.mouse.up()
}

test('metric questions split on Enter, use type buttons, and drag like task rows', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The phone layout is covered by mobile-metrics.spec.ts')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Metrics', exact: true }).click()
  await page.getByRole('button', { name: '+ New metric' }).first().click()

  const prompts = page.locator('[data-metric-question-text-input]')
  await prompts.first().fill('Energy score')
  await prompts.first().press('End')
  await prompts.first().press('Enter')

  await expect(prompts).toHaveCount(2)
  await expect(prompts.nth(1)).toBeFocused()
  await prompts.nth(1).fill('Hours slept')

  const secondRow = page.locator('[data-metric-question-id]').nth(1)
  const secondTypes = secondRow.getByRole('group', { name: 'Question type' })
  await expect(secondTypes.getByRole('button')).toHaveCount(3)
  await expect(secondTypes.getByRole('button', { name: 'Text', exact: true })).toHaveAttribute('aria-pressed', 'true')
  await secondTypes.getByRole('button', { name: 'Number', exact: true }).click()
  await expect(secondTypes.getByRole('button', { name: 'Number', exact: true })).toHaveAttribute('aria-pressed', 'true')

  await prompts.nth(1).focus()
  await prompts.nth(1).press('End')
  await prompts.nth(1).press('Enter')
  await prompts.nth(2).fill('Did you go outside?')
  const thirdRow = page.locator('[data-metric-question-id]').nth(2)
  await thirdRow.getByRole('group', { name: 'Question type' }).getByRole('button', { name: 'Yes / no' }).click()

  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.metrics?.[0]?.questions?.map((question: { prompt: string; type: string }) => ({
          prompt: question.prompt,
          type: question.type,
        }))
      }),
    )
    .toEqual([
      { prompt: 'Energy score', type: 'text' },
      { prompt: 'Hours slept', type: 'number' },
      { prompt: 'Did you go outside?', type: 'boolean' },
    ])

  await dragQuestionBefore(
    page,
    thirdRow.getByRole('button', { name: 'Drag to move question' }),
    page.locator('[data-metric-question-id]').first(),
  )

  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = JSON.parse(localStorage.getItem('balance.appState.v1') || '{}')
        return state.metrics?.[0]?.questions?.map((question: { prompt: string }) => question.prompt)
      }),
    )
    .toEqual(['Did you go outside?', 'Energy score', 'Hours slept'])
})
