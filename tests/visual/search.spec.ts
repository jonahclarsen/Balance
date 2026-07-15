import { expect, test } from '@playwright/test'

test('search finds saved days, list instances, and both template types without Enter', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()

  await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
  await page.evaluate(() => {
    const key = 'balance.appState.v1'
    const state = JSON.parse(localStorage.getItem(key) || '{}')
    const now = new Date().toISOString()

    state.plans.push({
      id: 'search-day',
      date: '2025-01-02',
      title: 'Archived planning day',
      dailyReminder: 'Keep it searchable',
      generatedFromTemplateId: state.templates[0].id,
      createdAt: now,
      items: [{
        id: 'search-day-item',
        text: 'Review the obsidian notebook',
        html: 'Review the obsidian notebook',
        done: false,
        startMinutes: null,
        endMinutes: null,
        children: [],
      }],
    })

    state.listTemplates.push({
      id: 'search-list-template',
      name: 'Market errands',
      maxExpectedWords: 0,
      createdAt: now,
      updatedAt: now,
      items: [{
        id: 'search-list-template-item',
        text: 'Buy saffron',
        html: 'Buy saffron',
        probability: 100,
        children: [],
      }],
    })
    state.lists.push({
      id: 'search-list',
      date: '2025-01-03',
      listTemplateId: 'search-list-template',
      createdAt: now,
      items: [{
        id: 'search-list-item',
        text: 'Buy saffron',
        html: 'Buy saffron',
        done: false,
        startMinutes: null,
        endMinutes: null,
        children: [],
      }],
    })
    localStorage.setItem(key, JSON.stringify(state))
  })
  await page.reload()

  await page.getByRole('button', { name: /Search/ }).click()
  const search = page.getByRole('searchbox', { name: 'Search everything' })
  await search.fill('obsidian')
  await expect(page.getByRole('heading', { name: /Saved days/ })).toBeVisible()
  await expect(page.getByRole('button', { name: /Archived planning day/ })).toBeVisible()

  await page.getByRole('button', { name: /Archived planning day/ }).click()
  await expect(page.locator('.date-input')).toHaveValue('2025-01-02')
  await expect(page.getByText('Review the obsidian notebook')).toBeVisible()

  await page.getByRole('button', { name: /Search/ }).click()
  await page.getByRole('searchbox', { name: 'Search everything' }).fill('saffron')
  await expect(page.getByRole('heading', { name: /List instances/ })).toBeVisible()
  await expect(page.getByRole('heading', { name: /List templates/ })).toBeVisible()

  await page.getByRole('searchbox', { name: 'Search everything' }).fill('wake up')
  await expect(page.getByRole('heading', { name: /Day templates/ })).toBeVisible()
})
