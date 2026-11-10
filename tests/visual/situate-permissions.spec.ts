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

test('missing access explains failures and opens each relevant setting', async ({ page }) => {
  await fixture(page)
  await expect(page.getByRole('status')).toHaveText('Situate needs access')
  await expect(page.getByText('Missing', { exact: true })).toHaveCount(6)
  await expect(page.getByText('Apps aren’t blocked.', { exact: true })).toBeVisible()
  await expect(page.getByText('Notifications aren’t silenced or saved.')).toBeVisible()
  await expect(page.getByText(/Samsung’s sleeping-app setting can’t be checked/)).toBeVisible()
  await page.screenshot({ path: 'artifacts/situate-access-missing.png' })
  for (const button of await page.getByRole('button', { name: /^Enable / }).all()) await button.click()
  expect(await page.evaluate(() => (window as any).__opened)).toEqual(['accessibility', 'notifications', 'usage', 'mode-notifications', 'alarms', 'battery'])

  await page.evaluate(() => {
    const runtime = window as any
    for (const key of Object.keys(runtime.__access)) runtime.__access[key] = true
    window.dispatchEvent(new Event('focus'))
  })
  await expect(page.getByRole('status')).toHaveText('All access granted')
  await expect(page.getByText('Missing', { exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: /^Manage / })).toHaveCount(6)

  await page.evaluate(() => {
    (window as any).__access.accessibility = false
    document.dispatchEvent(new Event('visibilitychange'))
  })
  await expect(page.getByRole('status')).toHaveText('Situate needs access')
  await expect(page.getByText('Apps aren’t blocked.', { exact: true })).toBeVisible()
})

test('failed checks stay explicit and can be retried', async ({ page }) => {
  await fixture(page, true)
  await expect(page.getByRole('status')).toContainText('Couldn’t check device access')
  await expect(page.getByText('Not checked', { exact: true })).toHaveCount(6)
  await page.evaluate(() => { (window as any).__failed = false })
  await page.getByRole('button', { name: 'Recheck' }).click()
  await expect(page.getByRole('status')).toHaveText('Situate needs access')
})
