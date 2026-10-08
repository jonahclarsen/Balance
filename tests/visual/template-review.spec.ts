import { expect, test, type Page } from '@playwright/test'
import {
  createDailyTemplate,
  createInitialState,
  createPlanItem,
  createTemplateItem,
  templateReviewURL,
} from '../../src/lib/planner'
import { openView } from '../helpers/navigation'

const DATE = '2026-10-01'
const DAY_TEMPLATE_ID = 'template_review_day'
const LIST_TEMPLATE_ID = 'list_template_review'

function seededState() {
  const state = createInitialState()
  const day = createDailyTemplate('Weekday')
  day.id = DAY_TEMPLATE_ID
  const move = createTemplateItem('Move')
  move.children = [createTemplateItem('Stretch'), createTemplateItem('Run')]
  day.items = [createTemplateItem('Wake up'), move, createTemplateItem('Read')]
  state.templates = [day]
  state.listTemplates = [{
    id: LIST_TEMPLATE_ID,
    name: 'Groceries',
    maxExpectedWords: 0,
    items: [
      { id: 'li_milk', text: 'Milk', html: 'Milk', probability: 100, children: [] },
      { id: 'li_eggs', text: 'Eggs', html: 'Eggs', probability: 100, children: [
        { id: 'li_brown', text: 'Brown', html: 'Brown', probability: 100, children: [] },
      ] },
      { id: 'li_bread', text: 'Bread', html: 'Bread', probability: 100, children: [] },
    ],
    archivedItems: [],
    createdAt: '2026-09-01T00:00:00Z',
    updatedAt: '2026-09-01T00:00:00Z',
  }]
  const dayLink = createPlanItem(`Recommit ${templateReviewURL('day', DAY_TEMPLATE_ID)}`)
  const listLink = createPlanItem(`Recommit ${templateReviewURL('list', LIST_TEMPLATE_ID)}`)
  state.plans = [{
    id: 'plan_today',
    date: DATE,
    title: '',
    dailyReminder: '',
    generatedFromTemplateId: null,
    createdAt: '2026-10-01T06:00:00Z',
    items: [dayLink, listLink],
  }]
  state.activePlanDate = DATE
  return state
}

async function openToday(page: Page) {
  await page.clock.setFixedTime(new Date(`${DATE}T12:00:00`))
  await page.addInitScript((state) => {
    if (!localStorage.getItem('balance.appState.v1')) localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, seededState())
  await page.goto('/')
  await openView(page, 'Today')
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
}

// A bare URL in task text renders as a data-attributed anchor; saved rich-text
// anchors (such as the starter goal's name) keep the balance:// href itself.
function reviewAnchor(page: Page, kind: 'day' | 'list', templateId: string) {
  return page.locator(
    `a[href="${templateReviewURL(kind, templateId)}"], a[data-internal-link-kind="templateReview"][data-internal-link-id="${kind}:${templateId}"]`,
  ).first()
}

function reviewDialog(page: Page) {
  return page.getByRole('dialog', { name: /^Item \d+ of \d+$/ })
}

function keepButton(page: Page) {
  return reviewDialog(page).getByRole('button', { name: /Keep|Read it/ })
}

async function templateSnapshot(page: Page) {
  return page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    await store.ready
    let state: any
    store.subscribe((value: any) => { state = value })()
    const outline = (items: any[]): any[] => items.map((item) => [
      item.options ? item.options.map((option: any) => option.text).join('/') : item.text,
      outline(item.children),
    ])
    return {
      day: outline(state.templates[0].items),
      list: outline(state.listTemplates[0].items),
      archived: state.listTemplates[0].archivedItems.map((entry: any) => entry.item.text),
    }
  })
}

async function undo(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore: store } = await import(/* @vite-ignore */ path)
    await store.undo()
  })
}

test('a day review link discards instantly, gates keeping on the read cooldown, and applies one undoable change', async ({ page }) => {
  await openToday(page)
  await reviewAnchor(page, 'day', DAY_TEMPLATE_ID).click()

  const dialog = reviewDialog(page)
  await expect(dialog).toBeVisible()
  await expect(dialog.getByText('Recommit to Weekday')).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Item 1 of 5' })).toBeVisible()
  await expect(keepButton(page)).toBeDisabled()

  // Keep is not armed yet, so Enter does nothing; discarding moves on at once.
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('heading', { name: 'Item 1 of 5' })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await expect(dialog.getByRole('heading', { name: 'Item 2 of 5' })).toBeVisible()
  await expect(dialog.getByText('0 kept · 1 discarded')).toBeVisible()

  await expect(keepButton(page)).toBeEnabled()
  await page.keyboard.press('Enter')
  await expect(dialog.getByRole('heading', { name: 'Item 3 of 5' })).toBeVisible()
  await dialog.getByRole('button', { name: 'Discard (←)' }).click()
  await dialog.getByRole('button', { name: 'Discard (←)' }).click()
  await expect(dialog.getByRole('heading', { name: 'Item 5 of 5' })).toBeVisible()
  await expect(keepButton(page)).toBeEnabled()
  await keepButton(page).click()
  await expect(dialog).toBeHidden()

  expect((await templateSnapshot(page)).day).toEqual([['Move', []], ['Read', []]])
  await undo(page)
  expect((await templateSnapshot(page)).day).toEqual([['Wake up', []], ['Move', [['Stretch', []], ['Run', []]]], ['Read', []]])
})

test('discarding a list parent drops its children too, and Escape leaves the list untouched', async ({ page }) => {
  await openToday(page)
  const link = reviewAnchor(page, 'list', LIST_TEMPLATE_ID)
  await link.click()

  const dialog = reviewDialog(page)
  await expect(dialog.getByText('Recommit to Groceries')).toBeVisible()
  await expect(dialog.getByRole('heading', { name: 'Item 1 of 4' })).toBeVisible()
  await page.keyboard.press('ArrowLeft')
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  expect((await templateSnapshot(page)).list).toEqual([['Milk', []], ['Eggs', [['Brown', []]]], ['Bread', []]])

  await link.click()
  await expect(dialog.getByRole('heading', { name: 'Item 1 of 4' })).toBeVisible()
  await expect(keepButton(page)).toBeEnabled()
  await page.keyboard.press('ArrowRight')
  await expect(dialog.getByRole('heading', { name: 'Item 2 of 4' })).toBeVisible()
  await page.keyboard.press('Delete')
  await expect(dialog.getByRole('heading', { name: 'Item 4 of 4' })).toBeVisible()
  await expect(dialog.getByText('1 kept · 2 discarded')).toBeVisible()
  await expect(keepButton(page)).toBeEnabled()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()

  const snapshot = await templateSnapshot(page)
  expect(snapshot.list).toEqual([['Milk', []], ['Bread', []]])
  expect(snapshot.archived).toEqual(['Eggs'])
})

test('the starter goal links to the default day review and template pages offer a copyable link', async ({ page }) => {
  // No fixed clock: the starter goal starts on the real day the state was built.
  const state = createInitialState()
  await page.addInitScript((state) => {
    if (!localStorage.getItem('balance.appState.v1')) localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  }, state)
  await page.goto('/')
  await openView(page, 'Goals')
  await reviewAnchor(page, 'day', state.templates[0].id).click()
  const dialog = reviewDialog(page)
  await expect(dialog.getByText('Recommit to Default day')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()

  await openView(page, 'Days')
  await page.getByRole('button', { name: 'Copy review link' }).click()
  await expect(page.getByRole('status').filter({ hasText: /Review link copied|Copy this link: balance:\/\/review\/day\// })).toBeVisible()
})
