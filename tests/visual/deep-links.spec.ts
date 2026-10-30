import { expect, test, type Locator, type Page } from '@playwright/test'
import { createInitialState, createNote, createNoteItem, createPlanItem, createListTemplate, createMetric } from '../../src/lib/planner'
import { closeNoteList, openNoteList, openView, primaryNavigation, showPrimaryNavigation } from '../helpers/navigation'
import { settleContextMenuTarget } from '../helpers/contextMenu'

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
    ['Empty group', 'balance://idea-group/trash'],
    ['Binned note', 'balance://note/binned'],
    ['Review genuine', 'balance://ideas/review/genuine'],
    ['Review possible', 'balance://ideas/review/possible'],
    ['Review afterlife', 'balance://ideas/review/afterlife'],
  ].map(([label, url]) => ({ ...createNoteItem(label), html: `<a href="${url}">${label}</a>` }))
  const destination = { ...createNote('Destination'), id: 'destination', items: [{ ...createNoteItem('A stable paragraph'), id: 'paragraph' }] }
  state.notes = [links, destination, { ...createNote('Binned destination'), id: 'binned', deletedAt: `${date}T17:00:00Z` }]
  state.plans = [{ id: 'synthetic_plan', date, title: 'Synthetic day', dailyReminder: '', generatedFromTemplateId: null, createdAt: `${date}T17:00:00Z`, items: [parent, createPlanItem('balance://note/link_index')] }]
  state.activePlanDate = date
  state.listTemplates = [createListTemplate('Synthetic list')]
  state.metrics = [createMetric('Synthetic quiz')]
  state.ideaBuckets = (['genuine', 'possible', 'afterlife'] as const).map(kind => ({
    id: `bucket_${kind}`, kind, items: [createPlanItem(`Synthetic ${kind} idea`)],
  }))
  state.plans[0].items.push(createPlanItem('balance://ideas/review/possible'))
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
  await settleContextMenuTarget(target)
  await target.click({ button: 'right' })
  await page.getByRole('menuitem', { name: 'Copy link', exact: true }).click()
  return page.evaluate(() => (window as any).__copiedLink as string)
}

async function index(page: Page) {
  await openView(page, 'Notes')
  await openNoteList(page)
  await page.locator('.note-card').filter({ hasText: 'Link index' }).click()
  await closeNoteList(page)
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
  await openNoteList(page)
  expect(await copyLink(page, page.locator('.note-card').filter({ hasText: 'Destination' }))).toBe('balance://note/destination')
  await closeNoteList(page)
  await page.locator('.note-document a').filter({ hasText: 'Child' }).click()
  await expect(page.locator('[data-plan-item-id="linked_child"]')).toBeVisible()
  await expect(page.locator('[data-plan-item-id="linked_child"]')).toHaveClass(/search-result-target/)
  expect(await copyLink(page, page.locator('[data-plan-item-id="linked_child"] .plan-item-main'))).toBe('balance://task/linked_child')
  await index(page)
  await page.locator('.note-document a').filter({ hasText: 'Paragraph' }).click()
  await expect(page.locator('[data-note-item-id="paragraph"]')).toBeVisible()
  // Establish the caret first so the editor's bottom-follow scroll finishes
  // before the context menu opens.
  await page.locator('[data-note-item-id="paragraph"] .note-text').click()
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
  await page.locator('.note-document a').filter({ hasText: 'Empty group' }).click()
  await expect(page.locator('[data-idea-group="trash"]')).toBeVisible()
  await index(page)
  await page.locator('.note-document a').filter({ hasText: 'Binned note' }).click()
  await expect(page.getByRole('heading', { name: 'Binned destination', exact: true })).toBeVisible()
  await expect(page.locator('.notes-trash-open')).toHaveCount(1)
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
        if (command === 'read_app_state_changes') return { state: structuredClone(state) }
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
  await page.evaluate(({ id, date }) => (window as any).__deliverLink(`balance://quiz/${id}?date=${date}`), { id: state.metrics[0].id, date })
  await expect(page.getByRole('dialog', { name: `Synthetic quiz · ${date}`, exact: true })).toBeVisible()
  await page.keyboard.press('Escape')
  await page.evaluate(() => (window as any).__deliverLink('balance://ideas/review/afterlife'))
  await expect(page.locator('.idea-sort[role="dialog"]')).toContainText('Synthetic afterlife idea')
})

test('each group copies a review link that reviews only its own ideas', async ({ page }) => {
  await seed(page)
  const dialog = page.locator('.idea-sort[role="dialog"]')
  for (const kind of ['possible', 'afterlife', 'genuine'] as const) {
    await openView(page, 'Ideas')
    await page.locator(`[data-idea-group="${kind}"] h3`).click({ button: 'right' })
    await page.getByRole('menuitem', { name: 'Copy review link' }).click()
    expect(await page.evaluate(() => (window as any).__copiedLink)).toBe(`balance://ideas/review/${kind}`)
    if (kind === 'possible') {
      await openView(page, 'Today')
      await page.locator('.day-pane a').filter({ hasText: 'balance://ideas/review/possible' }).click()
    } else {
      await index(page)
      await page.locator('.note-document a').filter({ hasText: `Review ${kind}` }).click()
    }
    await expect(dialog.locator('.idea-sort-card')).toContainText(`Synthetic ${kind} idea`)
    await expect(dialog.getByRole('progressbar')).toHaveAttribute('aria-valuemax', '1')
    await page.keyboard.press('n')
    await page.keyboard.press('t')
    await expect(dialog).toBeHidden()
    await expect.poll(() => page.evaluate(() => {
      const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
      return state.plans[0].items.filter((item: any) => item.done && item.text === 'Filter Genuinely Worth Doing').length
    })).toBe(kind === 'genuine' ? 1 : 0)
  }
  // Sorting and trash stay separate from the three reviewable groups.
  for (const kind of ['proposition', 'trash']) {
    await page.locator(`[data-idea-group="${kind}"] h3`).click({ button: 'right' })
    await expect(page.getByRole('menuitem', { name: 'Copy review link' })).toHaveCount(0)
    await page.keyboard.press('Escape')
  }
})

test('pasting a lone balance link inserts its titled link with a page icon', async ({ page }) => {
  await seed(page)
  const paste = (editor: Locator, text: string) => editor.evaluate((element, text) => {
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/plain', text)
    element.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
  }, text)

  await page.locator('[data-plan-item-id="collapsed_parent"] [contenteditable="true"]').click()
  await page.keyboard.press('End')
  await page.keyboard.type(' see ')
  await paste(page.locator('[data-plan-item-id="collapsed_parent"] [contenteditable="true"]'), 'balance://note/destination')
  await page.keyboard.type(' now')
  const taskLink = page.locator('[data-plan-item-id="collapsed_parent"] a[href="balance://note/destination"]')
  await expect(taskLink).toHaveText('Destination')
  expect(await taskLink.evaluate(element => getComputedStyle(element, '::before').maskImage || getComputedStyle(element, '::before').webkitMaskImage)).toContain('svg')
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).plans[0].items[0].html.replace(/\u00a0|&nbsp;/g, ' '))).toBe('Collapsed parent see <a href="balance://note/destination">Destination</a> now')
  await taskLink.click()
  await expect(page.getByRole('textbox', { name: 'Note title' })).toHaveValue('Destination')

  const paragraph = page.locator('[data-note-item-id="paragraph"] .note-text')
  await paragraph.click()
  await page.keyboard.press('End')
  await page.keyboard.type(' ')
  await paste(paragraph, 'balance://task/linked_child')
  await page.keyboard.type(' after')
  await expect(page.locator('.note-document a[href="balance://task/linked_child"]')).toHaveText('Linked child')
  await expect(paragraph).toHaveText('A stable paragraph Linked child after')

  // A link to something that no longer exists stays visible as the raw link.
  await paste(paragraph, ' balance://task/missing')
  await expect(page.locator('.note-document a[href="balance://task/missing"]')).toHaveCount(0)
  await expect(paragraph).toContainText('balance://task/missing')
})
