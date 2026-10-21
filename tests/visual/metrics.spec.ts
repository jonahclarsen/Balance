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

  await page.getByRole('button', { name: 'Quizzes', exact: true }).click()
  await page.getByRole('button', { name: '+ New quiz' }).first().click()

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

test('archiving a quiz hides it from the rail and it can be unarchived', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The phone layout is covered by mobile-metrics.spec.ts')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Quizzes', exact: true }).click()
  await page.getByRole('button', { name: '+ New quiz' }).first().click()
  await page.getByLabel('Quiz name').fill('Plank')

  await page.getByRole('button', { name: 'Archive quiz' }).click()
  await expect(page.getByRole('heading', { name: 'No quizzes yet' })).toBeVisible()
  await expect(page.locator('[data-metric-tab-id]')).toHaveCount(0)
  await expect
    .poll(() => page.evaluate(() => Boolean(JSON.parse(localStorage.getItem('balance.appState.v1') || '{}').metrics?.[0]?.archivedAt)))
    .toBe(true)

  await page.getByRole('button', { name: 'Archived (1)' }).click()
  const archivedChip = page.locator('[data-archived-metric-tab-id]', { hasText: 'Plank' })
  await expect(archivedChip).toContainText('Archived')
  await archivedChip.click()
  await expect(page.getByText('This quiz is archived and hidden from Quizzes.')).toBeVisible()
  await page.getByRole('button', { name: 'Unarchive' }).click()

  await expect(page.locator('[data-metric-tab-id]')).toHaveText(['Plank'])
  await expect(page.getByLabel('Quiz name')).toHaveValue('Plank')
  await expect(page.getByRole('button', { name: /^Archived \(/ })).toHaveCount(0)
})

test('typed line breaks in a quiz question show in its graph heading', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The phone layout is covered by mobile-metrics.spec.ts')
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('button', { name: 'Quizzes', exact: true }).click()
  await page.getByRole('button', { name: '+ New quiz' }).first().click()

  const prompt = page.locator('[data-metric-question-text-input]').first()
  await prompt.fill('Did you')
  await prompt.press('End')
  await prompt.press('Shift+Enter')
  await prompt.pressSequentially('go outside?')
  await page.locator('[data-metric-question-id]').first().getByRole('group', { name: 'Question type' })
    .getByRole('button', { name: 'Yes / no' }).click()

  await expect.poll(() => page.locator('.metric-graph-block h4').first().evaluate((heading) => (heading as HTMLElement).innerText))
    .toBe('Did you\ngo outside?')
})
