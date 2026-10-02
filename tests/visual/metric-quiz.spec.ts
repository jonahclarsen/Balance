import { expect, test, type Page } from '@playwright/test'

type SeedQuestion = { id: string; prompt: string; html?: string; type: 'text' | 'number' | 'boolean' }

async function seedQuiz(page: Page, questions: SeedQuestion[]) {
  await page.goto('/')
  await page.evaluate((questions) => {
    const date = new Date(Date.now() - 5 * 60 * 60 * 1000).toISOString().slice(0, 10)
    const now = new Date().toISOString()
    localStorage.setItem(
      'balance.appState.v1',
      JSON.stringify({
        schemaVersion: 1,
        deviceId: 'test-device',
        localSequence: 0,
        historyRevision: 0,
        activePlanDate: date,
        templates: [],
        plans: [
          {
            id: 'plan_test',
            date,
            title: 'Today',
            dailyReminder: '',
            generatedFromTemplateId: null,
            createdAt: now,
            items: [
              { id: 'item_mood', text: 'Mood', html: 'Mood', done: false, startMinutes: null, endMinutes: null, children: [] },
              { id: 'item_after', text: 'After', html: 'After', done: false, startMinutes: null, endMinutes: null, children: [] },
            ],
          },
        ],
        listTemplates: [],
        lists: [],
        metrics: [{
          id: 'metric_mood',
          name: 'Mood',
          questions: questions.map((question) => ({ html: '', ...question })),
          createdAt: now,
          updatedAt: now,
        }],
        metricEntries: [],
        goals: [],
        goalCompletions: [],
        operations: [],
      }),
    )
  }, questions)
  await page.reload()
}

const quizDialog = (page: Page) => page.getByRole('dialog', { name: /^Mood · / })

test('reopening a quiz shows the first question with its own answer', async ({ page }) => {
  await seedQuiz(page, [
    { id: 'q_first', prompt: 'First question', type: 'text' },
    { id: 'q_second', prompt: 'Second question', type: 'text' },
  ])

  // WebKit used to show the second prompt above the first answer here.
  await page.getByTitle('Open Mood').click()
  const dialog = quizDialog(page)
  await expect(dialog.locator('.metric-prompt')).toHaveText('First question')
  await dialog.getByRole('textbox').fill('calm')
  await dialog.getByRole('button', { name: 'Next →' }).click()
  await expect(dialog.locator('.metric-prompt')).toHaveText('Second question')
  await expect(dialog.getByRole('textbox')).toHaveValue('')

  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()

  await page.getByTitle('Open Mood').click()
  await expect(dialog.locator('.metric-prompt')).toHaveText('First question')
  await expect(dialog.getByRole('textbox')).toHaveValue('calm')
})

test('links in a quiz question are styled and open externally', async ({ page }) => {
  await seedQuiz(page, [{
    id: 'q_link',
    prompt: 'Read https://example.com/guide first',
    html: 'Read <a href="https://example.com/guide">https://example.com/guide</a> first',
    type: 'text',
  }])
  await page.evaluate(() => {
    const opened: string[] = []
    ;(window as unknown as { openedURLs: string[] }).openedURLs = opened
    window.open = (url?: string | URL) => {
      opened.push(String(url))
      return null
    }
  })

  await page.getByTitle('Open Mood').click()
  const dialog = quizDialog(page)
  const link = dialog.getByRole('link', { name: 'https://example.com/guide' })
  const colors = await link.evaluate((anchor) => [getComputedStyle(anchor).color, getComputedStyle(anchor.parentElement!).color])
  expect(colors[0]).not.toBe(colors[1])

  await link.click()
  await expect.poll(() => page.evaluate(() => (window as unknown as { openedURLs: string[] }).openedURLs)).toEqual(['https://example.com/guide'])
  await expect(dialog).toBeVisible()
  expect(new URL(page.url()).hostname).toBe('127.0.0.1')
})

test('going back keeps a typed answer and finishing checks off the task', async ({ page }) => {
  await seedQuiz(page, [
    { id: 'q_first', prompt: 'First question', type: 'text' },
    { id: 'q_second', prompt: 'How many?', type: 'number' },
  ])

  await page.getByTitle('Open Mood').click()
  const dialog = quizDialog(page)
  await page.keyboard.type('calm')
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('spinbutton', { name: 'How many?' })).toBeFocused()
  await page.keyboard.type('3')
  await dialog.getByRole('button', { name: '← Back' }).click()
  await expect(dialog.getByRole('textbox', { name: 'First question' })).toHaveValue('calm')
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('spinbutton', { name: 'How many?' })).toHaveValue('3')

  await dialog.getByRole('button', { name: 'Finish' }).click()
  await expect(dialog).toBeHidden()
  await expect(page.getByRole('checkbox').first()).toBeChecked()
})

test('yes/no questions answer from the keyboard one question per keypress', async ({ page }) => {
  await seedQuiz(page, [
    { id: 'q_first', prompt: 'Slept well?', type: 'boolean' },
    { id: 'q_second', prompt: 'Exercised?', type: 'boolean' },
  ])

  await page.getByTitle('Open Mood').click()
  const dialog = quizDialog(page)
  await expect(dialog.locator('.metric-prompt')).toHaveText('Slept well?')
  // Keys the quiz ignores must not reach the task the quiz was opened from.
  await page.keyboard.press('x')
  await page.keyboard.down('y')
  await page.keyboard.down('y')
  await page.keyboard.up('y')
  await expect(dialog.locator('.metric-prompt')).toHaveText('Exercised?')

  await page.keyboard.press('b')
  await expect(dialog.getByRole('button', { name: /^Yes/ })).toHaveAttribute('aria-pressed', 'true')
  await page.keyboard.press('s')
  await expect(dialog.getByRole('button', { name: /^Skip and finish/ })).toBeVisible()
  await expect(page.locator('[data-plan-text-input-id="item_mood"]')).toHaveText('Mood')
})
