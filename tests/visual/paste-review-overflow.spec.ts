import { expect, test } from '@playwright/test'

// A single unbroken token plus a long wrapping sentence: both must stay inside
// their review card rather than spilling past its rounded border.
const LONG_ITEMS = [
  'Supercalifragilisticexpialidocious-pneumonoultramicroscopicsilicovolcanoconiosis-antidisestablishmentarianism',
  'Remember to follow up with the whole cross-functional team about the quarterly planning retrospective and the long list of action items we agreed to revisit before the next review cycle',
  'Short one',
  'Another routine task that is also fairly wordy so that it spans more than a single line inside the narrow review card column',
]

async function openReviewWithLongItems(page: import('@playwright/test').Page) {
  await page.goto('/')
  await page.evaluate((itemTexts) => {
    const today = new Date().toISOString().slice(0, 10)
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10)
    const makeItem = (text: string, index: number) => ({
      id: `item_${index}`,
      text,
      html: text,
      done: false,
      startMinutes: null,
      endMinutes: null,
      children: [],
    })
    const state = {
      schemaVersion: 1,
      deviceId: 'test-device',
      localSequence: 0,
      historyRevision: 0,
      activePlanDate: today,
      templates: [],
      plans: [
        { id: 'plan_src', date: today, dailyReminder: '', items: itemTexts.map(makeItem) },
        { id: 'plan_dst', date: tomorrow, dailyReminder: '', items: [makeItem('Target day item', 99)] },
      ],
      goals: [],
      goalCompletions: [],
      operations: [],
    }
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, LONG_ITEMS)
  await page.reload()
  await expect(page.locator('[data-plan-text-input]').first()).toBeVisible()

  // Select all four seeded items and copy them to the internal structured clipboard.
  await page.locator('[data-plan-text-input]').first().focus()
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Shift+ArrowDown')
  await page.keyboard.press('Meta+C')

  // Move to the next (pre-seeded) day and paste — 4+ items onto a different day
  // opens the review queue.
  await page.getByRole('button', { name: 'Next day' }).click()
  await page.locator('[data-plan-text-input]').first().focus()
  await page.keyboard.press('Meta+V')

  await expect(page.getByRole('dialog', { name: /Item 1 of 4/ })).toBeVisible()
  await expect(page.locator('.paste-review-item')).toHaveCount(4)
}

test('long pasted items stay inside their review cards', async ({ page }, testInfo) => {
  await openReviewWithLongItems(page)

  await testInfo.attach('paste-review-long-items', {
    body: await page.locator('.paste-review').screenshot(),
    contentType: 'image/png',
  })

  // No card may have content taller than its own box (which would spill past the
  // rounded border), and the rendered text must sit within the card's bounds.
  const overflow = await page.locator('.paste-review-list').evaluate((list) => {
    const cards = Array.from(list.querySelectorAll<HTMLElement>('.paste-review-card'))
    return cards.map((card) => {
      const text = card.querySelector<HTMLElement>('.paste-review-text, .paste-review-edit')
      const cardRect = card.getBoundingClientRect()
      const textRect = text?.getBoundingClientRect()
      return {
        clipped: card.scrollHeight > card.clientHeight + 1,
        textOverflowsBottom: textRect ? textRect.bottom > cardRect.bottom + 1 : false,
        textOverflowsRight: textRect ? textRect.right > cardRect.right + 1 : false,
      }
    })
  })

  for (const card of overflow) {
    expect(card.clipped).toBe(false)
    expect(card.textOverflowsBottom).toBe(false)
    expect(card.textOverflowsRight).toBe(false)
  }

  const selectedAlignment = await page.locator('.paste-review-list').evaluate((list) => {
    const cards = Array.from(list.querySelectorAll<HTMLElement>('.paste-review-card'))
    const current = cards.find((card) => card.getAttribute('aria-current') === 'true')
    const comparison = cards.find((card) => card !== current)
    if (!current || !comparison) return null

    const listRect = list.getBoundingClientRect()
    const currentRect = current.getBoundingClientRect()
    const comparisonRect = comparison.getBoundingClientRect()
    const leftGrowth = comparisonRect.left - currentRect.left
    const rightGrowth = currentRect.right - comparisonRect.right
    const glowSpread = 3

    return {
      centeredGrowthDelta: Math.abs(leftGrowth - rightGrowth),
      growsRight: rightGrowth > 1,
      glowFitsLeft: currentRect.left - glowSpread >= listRect.left,
      glowFitsRight: currentRect.right + glowSpread <= listRect.right,
    }
  })

  expect(selectedAlignment).not.toBeNull()
  expect(selectedAlignment?.centeredGrowthDelta).toBeLessThan(1.5)
  expect(selectedAlignment?.growsRight).toBe(true)
  expect(selectedAlignment?.glowFitsLeft).toBe(true)
  expect(selectedAlignment?.glowFitsRight).toBe(true)
})
