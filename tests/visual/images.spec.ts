import { expect, test, type Page } from '@playwright/test'

test('Mac Cmd+V delivers the clipboard image to a list-template editor', async ({ page }) => {
  await notes(page)
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'Lists', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  const editor = page.locator('[data-list-template-text-input]').first()
  await editor.click()
  const delivered = await editor.evaluate(async (node) => {
    // WebKit can expose a raster image in the paste event even when a separate
    // native pasteboard read supplies no web-decodable image representation.
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Balance macOS synthetic test' })
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { transformCallback: () => 1, invoke: async () => ({ structuredPayload: null, plainText: null, html: null, imageDataURL: null }) } })
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { read: async () => [], readText: async () => '' } })
    const canvas = document.createElement('canvas'); canvas.width = 100; canvas.height = 60
    canvas.getContext('2d')!.fillRect(0, 0, 100, 60)
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    const data = new DataTransfer(); data.items.add(new File([png], 'synthetic.png', { type: 'image/png' }))
    const allowed = node.dispatchEvent(new KeyboardEvent('keydown', { key: 'v', code: 'KeyV', metaKey: true, bubbles: true, cancelable: true }))
    if (allowed) node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
    return allowed
  })
  expect(delivered).toBe(true)
  await expect(editor.locator('img')).toBeVisible()
  await page.evaluate(() => Object.assign(window, { isTauri: false }))
  await page.getByLabel('List name').click()
  await expect(editor.locator('img')).toBeVisible()
  const state = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!))
  expect(state.images).toHaveLength(1)
  expect(state.listTemplates.at(-1).items[0].html).toContain('data-balance-image=')
})

test('Mac list-template paste keeps whole rows and formatted text working', async ({ page }) => {
  await notes(page)
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'Lists', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  const editors = page.locator('[data-list-template-text-input]')
  await editors.first().fill('Original row')
  await editors.first().press('End')
  await editors.first().evaluate((node) => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    const item = state.listTemplates.at(-1).items[0]
    const structuredPayload = JSON.stringify({ kind: 'list-template', cut: false, items: [{ ...item, text: 'Copied row', html: 'Copied row' }] })
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Balance macOS synthetic test' })
    Object.assign(window, { isTauri: true, __TAURI_INTERNALS__: { transformCallback: () => 1, invoke: async () => ({ structuredPayload, plainText: 'Copied row', html: null }) } })
    const data = new DataTransfer(); data.setData('text/plain', 'Copied row')
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(editors).toHaveCount(2)
  await expect(editors.nth(1)).toHaveText('Copied row')
  await editors.first().click()
  await editors.first().press('End')
  await editors.first().evaluate((node) => {
    Object.assign(window, { __TAURI_INTERNALS__: { transformCallback: () => 1, invoke: async () => ({ structuredPayload: null, plainText: ' appended', html: null }) } })
    const data = new DataTransfer(); data.setData('text/plain', ' appended'); data.setData('text/html', '<strong> appended</strong>')
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }))
  })
  await expect(editors).toHaveCount(2)
  await expect(editors.first()).toHaveText('Original row appended')
  await expect(editors.first().locator('strong, b')).toHaveText(' appended')
  await page.evaluate(() => Object.assign(window, { isTauri: false }))
})

async function pasteSizeFixture(page: Page, size: number, noise = false) {
  await page.locator('[data-note-text-input]').first().evaluate(async (editor, { size, noise }) => {
    const canvas = document.createElement('canvas')
    canvas.width = noise ? 3200 : 64
    canvas.height = noise ? 2400 : 64
    const context = canvas.getContext('2d')!
    if (noise) {
      const pixels = context.createImageData(canvas.width, canvas.height)
      let seed = 123456789
      for (let offset = 0; offset < pixels.data.length; offset += 4) {
        for (let channel = 0; channel < 3; channel++) {
          seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5
          pixels.data[offset + channel] = seed & 255
        }
        pixels.data[offset + 3] = 255
      }
      context.putImageData(pixels, 0, 0)
    } else context.fillRect(0, 0, canvas.width, canvas.height)
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    const file = new File([png, new Uint8Array(Math.max(0, size - png.size))], 'size-fixture.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    editor.dispatchEvent(noise
      ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data })
      : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  }, { size, noise })
}

for (const size of [5_999_999, 6_000_000, 6_000_001]) {
  test(`image originals respect the strict 6 MB boundary at ${size} bytes`, async ({ page }) => {
    await notes(page)
    await pasteSizeFixture(page, size)
    const dialog = page.getByRole('dialog', { name: 'Paste image', exact: true })
    await expect(dialog).toBeVisible()
    const original = dialog.getByRole('button', { name: /^Paste original/ })
    if (size < 6_000_000) {
      await expect(original).toBeEnabled()
    } else {
      await expect(original).toBeDisabled()
      await expect(dialog.getByRole('status').filter({ hasText: 'Images must be smaller than 6 MB' })).toBeVisible()
      await page.keyboard.press('ControlOrMeta+Enter')
      await expect(dialog).toBeVisible()
      await expect(page.locator('[data-note-text-input] img')).toHaveCount(0)
    }
    await expect(dialog.getByRole('button', { name: /^Paste image(?: Enter)?$/, exact: true })).toBeEnabled()
    await page.keyboard.press('Enter')
    await expect(dialog).not.toBeVisible()
    await expect(page.locator('[data-note-text-input] img')).toBeVisible()
    const asset = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).images[0])
    expect(asset.bytes).toBeLessThan(6_000_000)
    expect(asset.dataURL).toMatch(/^data:image\/webp/)
  })
}

test('an oversized encoded result stays blocked until compression brings it below 6 MB', async ({ page }) => {
  test.setTimeout(60_000)
  await notes(page)
  await pasteSizeFixture(page, 6_000_001, true)
  const dialog = page.getByRole('dialog', { name: 'Paste image', exact: true })
  await expect(dialog).toBeVisible()
  const paste = dialog.getByRole('button', { name: /^Paste image(?: Enter)?$/, exact: true })
  await expect(paste).toBeEnabled({ timeout: 20_000 })
  for (const name of ['Image scale', 'WebP quality']) {
    await dialog.getByRole('slider', { name }).evaluate((node) => {
      ;(node as HTMLInputElement).value = '100'
      node.dispatchEvent(new Event('input', { bubbles: true }))
    })
  }
  await expect(dialog.locator('.image-size')).not.toContainText('Updating', { timeout: 20_000 })
  await expect(paste).toBeDisabled()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeVisible()
  await expect(page.locator('[data-note-text-input] img')).toHaveCount(0)
  await dialog.getByRole('slider', { name: 'Image scale' }).evaluate((node) => {
    ;(node as HTMLInputElement).value = '25'
    node.dispatchEvent(new Event('input', { bubbles: true }))
  })
  await expect(paste).toBeEnabled({ timeout: 20_000 })
  await paste.click()
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('[data-note-text-input] img')).toBeVisible()
  const asset = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).images[0])
  expect(asset.bytes).toBeLessThan(6_000_000)
  expect(asset.width).toBe(800)
})

async function notes(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'Notes', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: '+ New note' }).click()
  await page.locator('[data-note-text-input]').first().click()
}

async function pasteImage(page: Page, large = false, mixed = false, selector = '[data-note-text-input]') {
  await page.locator(selector).first().evaluate(async (editor, { large, mixed }) => {
    const canvas = document.createElement('canvas')
    canvas.width = large ? 3200 : 200
    canvas.height = large ? 2000 : 120
    const context = canvas.getContext('2d')!
    context.fillStyle = '#2f6f68'; context.fillRect(0, 0, canvas.width, canvas.height)
    context.fillStyle = '#ffffff'; context.font = '32px sans-serif'; context.fillText('Synthetic image', 12, 60)
    const png = await new Promise<Blob>((resolve) => canvas.toBlob((blob) => resolve(blob!), 'image/png'))
    // Valid PNG with ignored trailing bytes exercises the size threshold without
    // generating a huge random fixture or depending on an encoder's compression.
    const file = new File(large ? [png, new Uint8Array(1_000_001)] : [png], 'fixture.png', { type: 'image/png' })
    const data = new DataTransfer()
    data.items.add(file)
    if (mixed) { data.setData('text/html', '<p>A web passage<img src="https://example.invalid/picture.png"></p>'); data.setData('text/plain', 'A web passage') }
    editor.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  }, { large, mixed })
  if (!mixed) {
    if (large) await expect(page.getByRole('dialog', { name: 'Paste image', exact: true })).toBeVisible()
    else await expect(page.locator(selector).first().locator('img')).toBeVisible()
  }
}

test('new images wrap multiple text lines and Inline is the last layout option', async ({ page }) => {
  await notes(page)
  await pasteImage(page)
  const editor = page.locator('[data-note-text-input]').first()
  const image = editor.locator('img')
  await expect(image).toHaveAttribute('data-image-layout', 'left')
  await editor.evaluate((node) => {
    node.append(document.createTextNode('Text wraps beside this image. '.repeat(20)))
    node.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
  })
  const besideLines = await editor.evaluate((node) => {
    const image = node.querySelector('img')!
    const box = image.getBoundingClientRect()
    const range = document.createRange()
    range.setStartAfter(image); range.setEnd(node, node.childNodes.length)
    const rects = Array.from(range.getClientRects()).filter((rect) => rect.left >= box.right && rect.top >= box.top && rect.bottom <= box.bottom)
    return new Set(rects.map((rect) => Math.round(rect.top))).size
  })
  expect(besideLines).toBeGreaterThanOrEqual(2)
  await image.click()
  await expect(page.getByRole('toolbar', { name: 'Image layout' }).getByRole('button')).toHaveText(['Wrap left', 'Wrap right', 'Inline'])
  await page.getByRole('button', { name: 'Inline', exact: true }).click()
  await expect(image).toHaveAttribute('data-image-layout', 'inline')
  await expect(image).toHaveCSS('float', 'none')
})

test('small images survive text editing, reload, deletion, undo, and a full-window viewer', async ({ page }) => {
  await notes(page)
  const editor = page.locator('[data-note-text-input]').first()
  await editor.fill('Before ')
  await editor.press('End')
  await pasteImage(page)
  const image = editor.locator('img')
  await expect(image).toBeVisible()
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await editor.press('ArrowRight')
  await page.keyboard.type(' after')
  await expect(image).toBeVisible()
  const assetCount = () => page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).images.length)
  expect(await assetCount()).toBe(1)
  await image.dblclick()
  await expect(page.getByRole('dialog', { name: 'Image viewer' })).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('dialog[open]')).toHaveCount(0)
  await image.click()
  await editor.press('Backspace')
  await expect(image).toHaveCount(0)
  await page.keyboard.press('ControlOrMeta+z')
  await expect(image).toBeVisible()
  await page.reload()
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'Notes', exact: true }).filter({ visible: true }).click()
  await expect(page.locator('[data-note-text-input] img')).toBeVisible()
  expect(await assetCount()).toBe(1)
})

test('large images preview at the shorter-side default and paste the selected encoding', async ({ page }, info) => {
  await notes(page)
  await pasteImage(page, true)
  const dialog = page.getByRole('dialog', { name: 'Paste image', exact: true })
  await expect(dialog).toBeVisible()
  await expect(page.getByRole('slider', { name: 'Image scale' })).toHaveValue('75')
  await expect(page.getByRole('slider', { name: 'WebP quality' })).toHaveValue('80')
  await expect(page.getByRole('button', { name: /^Paste image(?: Enter)?$/, exact: true })).toBeEnabled()
  await page.screenshot({ path: info.outputPath('image-compression.png') })
  await page.keyboard.press('Enter')
  await expect(dialog).not.toBeVisible()
  await expect(page.locator('[data-note-text-input] img')).toBeVisible()
  const asset = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).images[0])
  expect(asset.width).toBe(2400)
  expect(asset.height).toBe(1500)
  expect(asset.dataURL).toMatch(/^data:image\/webp/)
})

test('original shortcut bypasses compression and mixed webpage paste excludes images', async ({ page }) => {
  await notes(page)
  await pasteImage(page, false, true)
  await expect(page.locator('[data-note-text-input] img')).toHaveCount(0)
  await expect(page.locator('[data-note-text-input]').first()).toContainText('A web passage')
  await pasteImage(page, true)
  await expect(page.getByRole('dialog', { name: 'Paste image', exact: true })).toBeVisible()
  await page.keyboard.press('ControlOrMeta+Enter')
  await expect(page.locator('[data-note-text-input] img')).toBeVisible()
  const asset = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).images[0])
  expect(asset.height).toBe(2000)
  expect(asset.bytes).toBeGreaterThan(1_000_000)
  expect(asset.dataURL).toMatch(/^data:image\/png/)
})

test('image copy reuses bytes and floating layout stays attached to the text', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'pointer resizing uses the desktop mouse')
  await notes(page)
  await pasteImage(page)
  const editor = page.locator('[data-note-text-input]').first()
  await editor.locator('img').click()
  await page.getByRole('button', { name: 'Wrap left', exact: true }).click()
  await expect(editor.locator('img')).toHaveAttribute('data-image-layout', 'left')
  await editor.locator('img').click()
  const handle = page.getByRole('button', { name: 'Resize image bottom-right' })
  const box = (await handle.boundingBox())!
  await page.mouse.move(box.x + 5, box.y + 5); await page.mouse.down(); await page.mouse.move(box.x + 85, box.y + 40); await page.mouse.up()
  await expect.poll(() => editor.locator('img').getAttribute('width')).not.toBe('200')
  await editor.evaluate((node) => {
    const image = node.querySelector('img')!
    const selection = document.getSelection()!
    const range = document.createRange(); range.selectNode(image); selection.removeAllRanges(); selection.addRange(range)
    const data = new DataTransfer()
    node.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
    range.selectNodeContents(node); range.collapse(false); selection.removeAllRanges(); selection.addRange(range)
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  })
  await expect(editor.locator('img')).toHaveCount(2)
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).images.length)).toBe(1)
})

test('dragging moves an image between text blocks and undo restores the destination', async ({ page }, info) => {
  test.skip(info.project.name === 'mobile', 'desktop drag event path')
  await notes(page)
  await pasteImage(page)
  let editors = page.locator('[data-note-text-input]')
  await editors.first().evaluate((node) => {
    const range = document.createRange(); range.selectNodeContents(node); range.collapse(false)
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
    ;(node as HTMLElement).focus()
  })
  await page.keyboard.press('Enter')
  await expect(editors).toHaveCount(2)
  await editors.nth(1).fill('Destination ')
  await editors.first().locator('img').dragTo(editors.nth(1))
  await expect(editors.first().locator('img')).toHaveCount(0)
  await expect(editors.nth(1).locator('img')).toBeVisible()
  await page.keyboard.press('ControlOrMeta+z')
  await expect(editors.nth(1).locator('img')).toHaveCount(0)
  await expect(editors.first().locator('img')).toBeVisible()
})

test('template generation snapshots image placement and reuses its asset', async ({ page }) => {
  await notes(page)
  await pasteImage(page)
  const result = await page.evaluate(async () => {
    const path = '/src/lib/planner.ts'
    const { createListTemplate, generateListFromTemplate, createDailyTemplate, generatePlanFromTemplate } = await import(/* @vite-ignore */ path)
    const html = document.querySelector('[data-note-text-input]')!.innerHTML
    const listTemplate = createListTemplate('Illustrated list')
    listTemplate.items[0].html = html
    listTemplate.items[0].text = ''
    const first = generateListFromTemplate(listTemplate, '2026-09-05')
    const second = generateListFromTemplate(listTemplate, '2026-09-06')
    listTemplate.items[0].html = 'Replacement'
    const dayTemplate = createDailyTemplate()
    dayTemplate.items[0].options[0].html = html
    dayTemplate.items[0].options[0].text = ''
    const plan = generatePlanFromTemplate(dayTemplate, '2026-09-05')
    return { first: first.items[0].html, second: second.items[0].html, plan: plan.items[0]?.html, count: JSON.parse(localStorage.getItem('balance.appState.v1')!).images.length }
  })
  expect(result.first).toContain('data-balance-image=')
  expect(result.second).toBe(result.first)
  expect(result.plan).toContain('data-balance-image=')
  expect(result.count).toBe(1)
})


test('an image-only list template item survives blur and backspace at its start', async ({ page }) => {
  await notes(page)
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'Lists', exact: true }).filter({ visible: true }).click()
  await page.getByRole('button', { name: '+ New list' }).click()
  const editor = page.locator('[data-list-template-text-input]').first()
  await editor.click()
  await pasteImage(page, false, false, '[data-list-template-text-input]')
  await page.getByLabel('List name').click()
  await expect(editor.locator('img')).toBeVisible()
  await editor.evaluate((node) => {
    ;(node as HTMLElement).focus()
    const range = document.createRange(); range.selectNodeContents(node); range.collapse(true)
    const selection = document.getSelection()!; selection.removeAllRanges(); selection.addRange(range)
  })
  await page.keyboard.press('Backspace')
  await expect(editor.locator('img')).toBeVisible()
})

test('clipboard copies carry their bytes after the database asset has been collected', async ({ page }) => {
  await notes(page)
  await pasteImage(page)
  const html = await page.locator('[data-note-text-input]').first().evaluate((node) => {
    const selection = document.getSelection()!
    const range = document.createRange(); range.selectNodeContents(node); selection.removeAllRanges(); selection.addRange(range)
    const data = new DataTransfer()
    node.dispatchEvent(new ClipboardEvent('copy', { bubbles: true, cancelable: true, clipboardData: data }))
    return data.getData('text/html')
  })
  expect(html).toContain('data:image/png;base64,')
  await page.evaluate(() => {
    const state = JSON.parse(localStorage.getItem('balance.appState.v1')!)
    state.images = []; state.operations = []
    state.notes[0].items[0].html = ''; state.notes[0].items[0].text = ''
    localStorage.setItem('balance.appState.v1', JSON.stringify(state))
  })
  await page.reload()
  const menu = page.getByRole('button', { name: 'Open navigation', exact: true })
  if (await menu.isVisible()) await menu.click()
  await page.getByRole('button', { name: 'Notes', exact: true }).filter({ visible: true }).click()
  const editor = page.locator('[data-note-text-input]').first()
  await editor.click()
  await editor.evaluate((node, html) => {
    const data = new DataTransfer(); data.setData('text/html', html)
    node.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }))
  }, html)
  await expect(editor.locator('img')).toBeVisible()
  const image = await page.evaluate(() => JSON.parse(localStorage.getItem('balance.appState.v1')!).images[0])
  expect(image.width).toBe(200)
  expect(image.dataURL).toMatch(/^data:image\/png;base64,/)
})
