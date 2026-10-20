import { expect, test, type Locator, type Page } from '@playwright/test'
import { createInitialState, createNote, createNoteItem, createPlanItem, createListTemplate, createMetric } from '../../src/lib/planner'
import { openView, primaryNavigation, showPrimaryNavigation } from '../helpers/navigation'

test.setTimeout(90_000)

const date = '2026-10-20'
function fixture() {
  const state = createInitialState()
  const child = { ...createPlanItem('Linked child'), id: 'linked_child' }
  const parent = { ...createPlanItem('Collapsed parent'), id: 'collapsed_parent', children: [child] }
  const links = createNote('Link index')
  links.id = 'link_index'
  links.items = [
    ['Child', 'balance://task/linked_child'],
    ['Day template', `balance://day-template/${state.templates[0].id}`],
    ['Missing task', 'balance://task/missing'],
    ['Settings page', 'balance://page/settings'],
    ['Paragraph', 'balance://note/destination?item=paragraph'],
    ['Empty bucket', 'balance://bucket/trash'],
    ['Binned note', 'balance://note/binned'],
  ].map(([label, url]) => ({ ...createNoteItem(label), html: `<a href="${url}">${label}</a>` }))
  const destination = { ...createNote('Destination'), id: 'destination', items: [{ ...createNoteItem('A stable paragraph'), id: 'paragraph' }] }
  state.notes = [links, destination, { ...createNote('Binned destination'), id: 'binned', deletedAt: `${date}T17:00:00Z` }]
  state.plans = [{ id: 'synthetic_plan', date, title: 'Synthetic day', dailyReminder: '', generatedFromTemplateId: null, createdAt: `${date}T17:00:00Z`, items: [parent, createPlanItem('balance://note/link_index')] }]
  state.activePlanDate = date
  state.listTemplates = [createListTemplate('Synthetic list')]
  state.metrics = [createMetric('Synthetic quiz')]
  return state
}

async function seed(page: Page) {
  const state = fixture()
  await page.clock.setFixedTime(new Date(`${date}T17:00:00Z`))
  await page.addInitScript(state => {
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
    localStorage.setItem('balance.collapsedPlanItems', JSON.stringify(['collapsed_parent']))
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: {
      writeText: async (text: string) => { (window as any).__copiedLink = text },
    } })
  }, state)
  await page.goto('/')
  return state
}

async function copyLink(page: Page, target: Locator) {
  await target.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy link', exact: true }).click()
  return page.evaluate(() => (window as any).__copiedLink as string)
}

async function index(page: Page) {
  await openView(page, 'Notes')
  await page.locator('.note-card').filter({ hasText: 'Link index' }).click()
}

test('context links choose the nearest object and return to tasks and note paragraphs', async ({ page }) => {
  const state = await seed(page)
  await expect(page.locator('.day-pane h2')).toContainText('Synthetic day')
  await page.evaluate(async () => {
    const path = '/src/lib/collapsedPlanItems.ts'
    const { setPlanItemCollapsed } = await import(/* @vite-ignore */ path)
    setPlanItemCollapsed('collapsed_parent', true)
  })
  await expect(page.locator('[data-plan-item-id="linked_child"]')).toHaveCount(0)
  expect(await copyLink(page, page.locator('.day-pane h2'))).toBe(`balance://day/${date}`)
  expect(await copyLink(page, page.locator('[data-plan-item-id="collapsed_parent"] .plan-item-main'))).toBe('balance://task/collapsed_parent')
  await index(page)
  expect(await copyLink(page, page.locator('.note-card').filter({ hasText: 'Destination' }))).toBe('balance://note/destination')
  await page.locator('.note-document a').filter({ hasText: 'Child' }).click()
  await expect(page.locator('[data-plan-item-id="linked_child"]')).toBeVisible()
  await expect(page.locator('[data-plan-item-id="linked_child"]')).toHaveClass(/search-result-target/)
  expect(await copyLink(page, page.locator('[data-plan-item-id="linked_child"] .plan-item-main'))).toBe('balance://task/linked_child')
  await index(page)
  await page.locator('.note-document a').filter({ hasText: 'Paragraph' }).click()
  await expect(page.locator('[data-note-item-id="paragraph"]')).toBeVisible()
  expect(await copyLink(page, page.locator('[data-note-item-id="paragraph"]'))).toBe('balance://note/destination?item=paragraph')
  await page.locator('[data-note-item-id="paragraph"] .note-text').evaluate(element => {
    element.closest<HTMLElement>('[contenteditable="true"]')?.focus()
    const range = document.createRange()
    range.selectNodeContents(element)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', 'balance://task/linked_child')
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  })
  const pasted = page.locator('.note-document a[href="balance://task/linked_child"]')
  await expect(pasted).toHaveText('A stable paragraph')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).notes.find((note: any) => note.id === 'destination').items[0].html)).toContain('balance://task/linked_child')
  await pasted.click()
  await expect(page.locator('[data-plan-item-id="linked_child"]')).toBeVisible()
  await index(page)
  await page.locator('.note-document a').filter({ hasText: 'Day template' }).click()
  await expect(page.getByLabel('Template name', { exact: true })).toHaveValue(state.templates[0].name)
  expect(await copyLink(page, page.locator('[data-day-template-tab-id]').first())).toBe(`balance://day-template/${state.templates[0].id}`)
  await index(page)
  await page.locator('.note-document a').filter({ hasText: 'Missing task' }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Link destination unavailable' })).toBeVisible()
  await page.locator('.note-document a').filter({ hasText: 'Settings page' }).click()
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
  await index(page)
  await page.locator('.note-document a').filter({ hasText: 'Empty bucket' }).click()
  await expect(page.locator('[data-bucket="trash"]')).toBeVisible()
  await index(page)
  await page.locator('.note-document a').filter({ hasText: 'Binned note' }).click()
  await expect(page.getByLabel('Note title', { exact: true })).toHaveValue('Binned destination')
  await expect(page.locator('.notes-trash-open')).toBeVisible()
})

test('page menus dismiss with Escape and preserve review links', async ({ page }) => {
  const state = await seed(page)
  await openView(page, 'Lists')
  const tab = page.locator(`[data-list-template-tab-id="${state.listTemplates[0].id}"]`)
  await tab.click({ button: 'right' })
  await expect(page.getByRole('menuitem', { name: 'Copy link', exact: true })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await expect(page.getByRole('menuitem', { name: 'Copy review link' })).toBeFocused()
  await page.keyboard.press('Enter')
  expect(await page.evaluate(() => (window as any).__copiedLink)).toBe(`balance://review/list/${state.listTemplates[0].id}`)
  await tab.click({ button: 'right' })
  await page.keyboard.press('Escape')
  await expect(page.getByRole('menu')).toHaveCount(0)
  await showPrimaryNavigation(page)
  expect(await copyLink(page, primaryNavigation(page).getByRole('button', { name: 'Goals', exact: true }))).toBe('balance://page/goals')
})

test('native launch queue routes navigation after loading the workspace', async ({ page }) => {
  const state = fixture()
  await page.addInitScript(state => {
    const runtime = window as any
    const callbacks = new Map<number, (event: unknown) => void>()
    let callbackId = 0
    runtime.isTauri = true
    runtime.__acknowledged = []
    runtime.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} }
    runtime.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
      transformCallback: (callback: (event: unknown) => void) => { callbacks.set(++callbackId, callback); return callbackId },
      unregisterCallback: () => {},
      invoke: async (command: string, args: any) => {
        if (command === 'read_app_state') return JSON.stringify(state)
        if (command === 'pending_deep_links') return ['balance://note/destination?item=paragraph']
        if (command === 'acknowledge_deep_link') { runtime.__acknowledged.push(args.url); return }
        if (command === 'get_sync_settings') return { enabled: false, pairingCode: null, relayUrl: '' }
        if (command === 'get_database_maintenance_status') return { due: false }
        if (command === 'get_export_settings') return { exportDirectory: '/tmp', defaultExportDirectory: '/tmp', usesDefaultExportDirectory: true }
        if (command === 'build_info') return { version: 'test', commit: 'test' }
        if (command === 'plugin:event|listen') {
          if (args.event === 'balance-deep-link') runtime.__deliverLink = (url: string) => callbacks.get(args.handler)?.({ event: args.event, id: 1, payload: url })
          return 1
        }
        return null
      },
    }
  }, state)
  await page.goto('/')
  await expect(page.locator('[data-note-item-id="paragraph"]')).toBeVisible()
  await expect.poll(() => page.evaluate(() => (window as any).__acknowledged)).toContain('balance://note/destination?item=paragraph')
  await page.evaluate(() => (window as any).__deliverLink('balance://page/settings'))
  await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible()
})
