import { expect, test } from '@playwright/test'
import { openView } from '../helpers/navigation'
import { createScreenshotState } from '../../website/capture/seed'

for (const [id, name] of [['windows98', 'Windows 98'], ['system1', 'System 1']] as const) {
  test(`${name} can be selected, survives reload, and stays usable in both appearances`, async ({ page }, testInfo) => {
    await page.clock.install({ time: new Date('2026-10-14T14:20:00') })
    await page.emulateMedia({ colorScheme: 'light' })
    await page.goto('/')
    await page.evaluate(state => {
      localStorage.clear()
      localStorage.setItem('balance.appState.v1', JSON.stringify(state))
      localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, themeId: 'graphite', colorScheme: 'system' }))
    }, createScreenshotState('2026-10-14'))
    await page.reload()
    await openView(page, 'Settings')
    await page.getByRole('group', { name: 'Color theme', exact: true }).getByRole('button', { name: new RegExp(`^${name} `) }).click()
    await expect(page.locator('html')).toHaveAttribute('data-theme', id)
    await page.reload()
    await expect(page.locator('html')).toHaveAttribute('data-theme', id)
    await openView(page, 'Today')
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme })
      await expect(page.locator('html')).toHaveAttribute('data-color-scheme', scheme)
      await expect(page.getByRole('navigation', { name: 'Primary', exact: true }).or(page.getByRole('button', { name: 'Open navigation', exact: true }))).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur()
        for (const el of document.querySelectorAll('*')) if (el.scrollTop) el.scrollTop = 0
      })
      await page.screenshot({ path: testInfo.outputPath(`${id}-${scheme}.png`) })
      await openView(page, 'Settings')
      await expect(page.getByRole('group', { name: 'Color theme', exact: true }).getByRole('button', { name: new RegExp(`^${name} `) })).toHaveAttribute('aria-pressed', 'true')
      await page.screenshot({ path: testInfo.outputPath(`${id}-${scheme}-settings.png`) })
      await openView(page, 'Today')
    }
    const checkbox = page.locator('.plan-row .check:not(:checked)').first()
    const itemId = await checkbox.evaluate(el => el.closest('[data-plan-item-id]')?.getAttribute('data-plan-item-id'))
    expect(itemId).toBeTruthy()
    await checkbox.check()
    await expect(page.locator(`[data-plan-item-id="${itemId}"] .check`)).toBeChecked()

  })
}
