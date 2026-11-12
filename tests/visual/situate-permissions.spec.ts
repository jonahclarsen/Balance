import { expect, test, type Page } from '@playwright/test'

async function fixture(page: Page, failed = false) {
  await page.route('**/access-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><head><link rel="stylesheet" href="/src/app.css"></head><body><main style="max-width:600px;margin:20px"></main></body></html>' }))
  await page.goto('/access-fixture')
  await page.evaluate(async (failed) => {
    const runtime = window as any
    runtime.__access = { accessibility: false, notifications: false, usage: false, 'mode-notifications': false, alarms: false, battery: false, samsung: true }
    runtime.__failed = failed
    runtime.__opened = []
    runtime.__TAURI_INTERNALS__ = { invoke: async (_: string, { action }: { action: string }) => {
      if (action === 'status') {
        if (runtime.__failed) throw new Error('Synthetic failure')
        return JSON.stringify(runtime.__access)
      }
      runtime.__opened.push(action)
    } }
    const svelte = '/node_modules/.vite/deps/svelte.js'
    const component = '/src/lib/SituatePermissions.svelte'
    const { mount } = await import(/* @vite-ignore */ svelte)
    const { default: Permissions } = await import(/* @vite-ignore */ component)
    mount(Permissions, { target: document.querySelector('main')! })
  }, failed)
}

test('missing permissions stay collapsed until clicked, then open the relevant settings', async ({ page }) => {
  await fixture(page)
  const notice = page.getByRole('button', { name: '6 permissions missing' })
  await expect(notice).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: /^Enable / })).toHaveCount(0)
  await expect(page.getByText(/Samsung’s sleeping-app setting/)).toHaveCount(0)
  await page.screenshot({ path: 'artifacts/situate-access-collapsed.png' })
  await notice.click()
  await expect(notice).toHaveAttribute('aria-expanded', 'true')
  await expect(page.getByText('Apps aren’t blocked.', { exact: true })).toBeVisible()
  for (const button of await page.getByRole('button', { name: /^Enable / }).all()) await button.click()
  expect(await page.evaluate(() => (window as any).__opened)).toEqual(['accessibility', 'notifications', 'usage', 'mode-notifications', 'alarms', 'battery'])
  await notice.click()
  await expect(page.getByRole('button', { name: /^Enable / })).toHaveCount(0)
})

test('granted access disappears and a later revocation starts collapsed with only the missing permission', async ({ page }) => {
  await fixture(page)
  await page.getByRole('button', { name: '6 permissions missing' }).click()
  await page.evaluate(() => {
    const runtime = window as any
    for (const key of Object.keys(runtime.__access)) runtime.__access[key] = true
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByRole('region', { name: 'Device access' })).toHaveCount(0)
  await page.evaluate(() => {
    (window as any).__access.accessibility = false
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const notice = page.getByRole('button', { name: '1 permission missing', exact: true })
  await expect(notice).toHaveAttribute('aria-expanded', 'false')
  await expect(page.getByRole('button', { name: /^Enable / })).toHaveCount(0)
  await notice.click()
  await expect(page.getByRole('button', { name: /^Enable / })).toHaveCount(1)
  await expect(page.getByRole('button', { name: 'Enable Accessibility access', exact: true })).toBeVisible()
  await expect(page.getByText('Notification access', { exact: true })).toHaveCount(0)
})

test('failed checks can be expanded and retried', async ({ page }) => {
  await fixture(page, true)
  await page.getByRole('button', { name: 'Couldn’t check device access' }).click()
  await page.evaluate(() => { (window as any).__failed = false })
  await page.getByRole('button', { name: 'Recheck' }).click()
  await expect(page.getByRole('status')).toHaveText('6 permissions missing')
})
