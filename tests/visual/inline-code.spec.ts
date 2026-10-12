import { expect, test, type Locator, type Page } from '@playwright/test'
import { generateDay, openView } from '../helpers/navigation'

async function selectText(input: Locator, start: number, end: number) {
  await input.evaluate(async (element, [a, b]) => {
    const editable = element.closest<HTMLElement>('[contenteditable="true"]') ?? element as HTMLElement
    editable.focus()
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
    const nodes: Text[] = []
    for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text)
    const point = (offset: number): [Node, number] => {
      for (const node of nodes) {
        if (offset <= node.length) return [node, offset]
        offset -= node.length
      }
      throw new Error('Selection offset outside text')
    }
    document.getSelection()!.setBaseAndExtent(...point(a), ...point(b))
    // Let editor adapters observe the native selectionchange before typing.
    await new Promise<void>(resolve => requestAnimationFrame(() => resolve()))
  }, [start, end])
}

const codeTexts = (input: Locator) => input.locator('code').allTextContents()

async function openTaskInput(page: Page, view: string, isMobile: boolean) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  if (view === 'Lists') {
    await openView(page, 'Lists')
    await page.getByRole('button', { name: '+ New list' }).click()
  } else {
    if (view === 'Today') await generateDay(page)
    await openView(page, view)
    // Choosing Today again focuses its next unchecked task on desktop; let
    // that land first. Mobile only scrolls to it.
    if (view === 'Today' && !isMobile) await expect(page.locator('[data-plan-text-input]:focus')).toHaveCount(1)
  }
  const selector = view === 'Lists' ? '[data-list-template-text-input]'
    : view === 'Days' ? '[data-template-option-text-input]' : '[data-plan-text-input]'
  return page.locator(selector).first()
}

for (const view of ['Today', 'Days', 'Lists']) {
  test(`${view} turns backticked task text into inline code`, async ({ page }, testInfo) => {
    const input = await openTaskInput(page, view, testInfo.project.name === 'mobile')
    await input.fill('')
    await page.keyboard.type('run `pnpm test` now')
    await expect(input).toHaveText('run pnpm test now')
    await expect.poll(() => codeTexts(input)).toEqual(['pnpm test'])

    await selectText(input, 0, 3)
    await page.keyboard.press('`')
    await expect.poll(() => codeTexts(input)).toEqual(['run', 'pnpm test'])
    await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('run')
    await selectText(input, 4, 9)
    await page.keyboard.press('`')
    await expect(input).toHaveText('run pnpm test now')
    await expect.poll(() => codeTexts(input)).toEqual(['run', 'test'])

    await input.blur()
    await page.reload()
    await openView(page, view)
    await expect(input).toHaveText('run pnpm test now')
    await expect.poll(() => codeTexts(input)).toEqual(['run', 'test'])
  })
}

test('Notes turns backticked text into inline code', async ({ page }) => {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    const item = (id: string, html: string, text: string) => ({ id, kind: 'paragraph', html, text, done: false, startMinutes: null, endMinutes: null, children: [] })
    state.notes = [{ id: 'code-note', title: 'Inline code', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), deletedAt: null,
      items: [item('code-one', 'run ', 'run ')] }]
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  await openView(page, 'Notes')
  const input = page.locator('[data-item-id="code-one"]').first()
  await selectText(input, 4, 4)
  await page.keyboard.type('`pnpm test` now')
  await expect(input).toHaveText('run pnpm test now')
  await expect.poll(() => codeTexts(input)).toEqual(['pnpm test'])

  await selectText(input, 0, 3)
  await page.keyboard.press('`')
  await expect.poll(() => codeTexts(input)).toEqual(['run', 'pnpm test'])
  await expect.poll(() => page.evaluate(() => document.getSelection()?.toString())).toBe('run')
  await page.keyboard.press('Control+z')
  await expect.poll(() => codeTexts(input)).toEqual(['pnpm test'])

  await expect.poll(() => page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    return state.notes[0].items[0].html
  })).toBe('run <code>pnpm test</code> now')
  await page.reload()
  await openView(page, 'Notes')
  await expect.poll(() => codeTexts(input)).toEqual(['pnpm test'])
})
