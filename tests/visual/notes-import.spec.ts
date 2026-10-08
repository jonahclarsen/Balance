import { expect, test, type Page } from '@playwright/test'
import { openView } from '../helpers/navigation'

async function openNote(page: Page, editor = 'classic') {
  await page.goto('/')
  await page.evaluate((choice) => { localStorage.clear(); localStorage.setItem('balance:noteEditor.v1', choice) }, editor)
  await page.reload()
  await openView(page, 'Notes')
  await page.getByRole('button', { name: '+ New note' }).click()
  const input = page.locator('.note-document [contenteditable="true"]').first()
  await input.click()
  return input
}

async function state(page: Page) {
  return page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!))
}

for (const editor of ['classic', 'tiptap', 'lexical']) {
  test(`${editor}: Notesnook headings, mixed lists and checked items survive paste, edit and reload`, async ({ page }) => {
    const input = await openNote(page, editor)
    await input.evaluate((node) => {
      const data = new DataTransfer()
      data.setData('text/plain', 'Title\nSubtitle\nIntro\nFirst\nNested\nOpen\nDone\nTail')
      data.setData('text/html', `<meta charset="utf-8"><div><h1 data-pm-slice="1 3 []">Title</h1><h2>Subtitle</h2><p data-spacing="double">Intro <strong><em><u>format</u></em></strong></p><ul><li style="font-size: 13px">First<ol><li><a href="https://example.com">Nested</a></li></ol></li></ul><ul class="checklist"><li class="checklist--item">Open</li><li class="checked checklist--item">Done</li></ul><p>Tail</p></div>`)
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await expect.poll(async () => (await state(page)).notes[0].items.length).toBe(7)
    const items = (await state(page)).notes[0].items
    expect(items.map((item: { kind: string }) => item.kind)).toEqual(['heading', 'heading', 'paragraph', 'bullet', 'checklist', 'checklist', 'paragraph'])
    expect(JSON.stringify(items)).not.toContain('style=')
    expect(items[2].html).toMatch(/<(?:strong|b)>/)
    expect(items[2].html).toContain('<em>')
    expect(items[2].html).toContain('<u>')
    expect(items[3].children[0].kind).toBe('numbered')
    expect(items[3].children[0].html).toContain('https://example.com')
    expect(items[4].done).toBe(false)
    expect(items[5].done).toBe(true)
    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(async () => (await state(page)).notes[0].items.length).toBe(1)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(async () => (await state(page)).notes[0].items.length).toBe(7)
    await page.locator('.note-document [contenteditable="true"]').last().evaluate((node) => {
      const range = document.createRange(); range.selectNodeContents(node); range.collapse(false)
      ;(node as HTMLElement).focus()
      const selection = document.getSelection(); selection?.removeAllRanges(); selection?.addRange(range)
    })
    await page.keyboard.type(' edited')
    await page.getByLabel('Note title').click()
    await page.reload()
    await openView(page, 'Notes')
    await expect(page.locator('.note-document')).toContainText('Tail edited')
    expect((await state(page)).notes[0].items[0].kind).toBe('heading')
    expect((await state(page)).notes[0].items[5].done).toBe(true)
  })

  test(`${editor}: Apple rich text imports its native HTML and image in one undo step`, async ({ page }) => {
    const input = await openNote(page, editor)
    await input.evaluate((node) => {
      const canvas = document.createElement('canvas'); canvas.width = 80; canvas.height = 40
      canvas.getContext('2d')!.fillRect(0, 0, 80, 40)
      const html = `<html><head><style>p.p1 {font: 20px 'Helvetica Neue'} p.p2 {font: 13px 'Helvetica Neue'} span.s1 {text-decoration: underline}</style></head><body><p class="p1"><b>Native title</b></p><p class="p2">Before<img src="${canvas.toDataURL()}" width="80" height="40">After</p><p class="p2">Body <b>bold</b> <span class="s1">under</span></p></body></html>`
      Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { transformCallback: () => 1, invoke: async () => ({ html, plainText: 'Native title\nBefore\uFFFCAfter\nBody bold under' }) } })
      const data = new DataTransfer(); data.setData('text/plain', 'Native title\nBefore\uFFFCAfter\nBody bold under')
      node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    })
    await expect(page.locator('.note-document img[data-balance-image]')).toBeVisible()
    await page.evaluate(() => Object.assign(window, { isTauri: false }))
    await page.getByLabel('Note title').click()
    const pasted = (await state(page)).notes[0].items
    // Apple's fonts and sizes give way to Balance's paragraph and heading type.
    expect(pasted.map((item: { kind: string }) => item.kind)).toEqual(['heading', 'paragraph', 'paragraph'])
    expect(pasted[0].html).toBe('Native title')
    expect(pasted[1].text).toBe('BeforeAfter')
    expect(pasted[2].html).toBe('Body <strong>bold</strong> <u>under</u>')
    expect(JSON.stringify(pasted)).not.toContain('style=')
    expect(pasted[1].html).not.toContain('data:image/')
    expect((await state(page)).images).toHaveLength(1)
    await page.locator('.note-document [contenteditable="true"]').first().click()
    await page.keyboard.press('ControlOrMeta+z')
    await expect(page.locator('.note-document img')).toHaveCount(0)
    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect(page.locator('.note-document img[data-balance-image]')).toBeVisible()
    await page.reload()
    await openView(page, 'Notes')
    await expect(page.locator('.note-document img[data-balance-image]')).toBeVisible()
  })
}

test('multiple embedded images use the normal compression dialog sequentially and preserve surrounding text', async ({ page }) => {
  const input = await openNote(page)
  await input.evaluate(async (node) => {
    const canvas = document.createElement('canvas'); canvas.width = 120; canvas.height = 80
    canvas.getContext('2d')!.fillRect(0, 0, 120, 80)
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    const image = await new Promise<string>((resolve) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result))
      reader.readAsDataURL(new Blob([png, new Uint8Array(1_000_001)], { type: 'image/png' }))
    })
    const data = new DataTransfer()
    data.setData('text/html', `<p>Before</p><p><img src="${image}"></p><p>Between</p><p><img src="${image}"></p><p>After</p>`)
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  const dialog = page.getByRole('dialog', { name: 'Paste image' })
  await expect(dialog.getByRole('heading')).toHaveText('Paste image 1 of 2')
  const confirm = dialog.getByRole('button', { name: /^Paste image(?: Enter)?$/ })
  await expect(confirm).toBeEnabled({ timeout: 20000 })
  await confirm.click()
  await expect(dialog.getByRole('heading')).toHaveText('Paste image 2 of 2')
  await dialog.getByRole('button', { name: /^Skip image/ }).click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('.note-document img[data-balance-image]')).toHaveCount(1)
  await expect(page.locator('.note-document')).toContainText('Between')
  await expect(page.locator('.note-document')).toContainText('After')
  const saved = await state(page)
  expect(saved.images[0].dataURL).toMatch(/^data:image\/webp/)
  expect(saved.images[0].bytes).toBeLessThan(1_000_000)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(page.locator('.note-document img')).toHaveCount(0)
})
