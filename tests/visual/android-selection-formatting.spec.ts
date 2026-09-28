import { readFileSync } from 'node:fs'
import { expect, test } from '@playwright/test'

const script = readFileSync('.github/android/selection-formatting.js', 'utf8')

for (const [pageName, selector] of [
  ['Today', '[data-plan-text-input]'],
  ['Lists', '[data-list-template-text-input]'],
  ['Day Templates', '[data-template-option-text-input]'],
] as const) {
  test(`Android selection formatting saves and toggles in ${pageName}`, async ({ page }, info) => {
    await page.goto('/')
    await page.evaluate(() => localStorage.clear())
    await page.reload()
    if (info.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click()
    if (pageName === 'Today') {
      await page.getByRole('complementary').getByRole('button', { name: 'Generate today' }).click()
      if (info.project.name === 'mobile') await page.getByRole('complementary').getByRole('button', { name: 'Close navigation' }).click()
    } else {
      await page.getByRole('button', { name: pageName, exact: true }).click()
      if (pageName === 'Lists') await page.getByRole('button', { name: 'New list' }).click()
    }
    const editor = page.locator(selector).first()
    await editor.focus()
    await editor.evaluate(element => {
      element.textContent = 'Format this task'
      element.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }))
    })
    for (const [command, tag] of [['bold', 'strong'], ['italic', 'em'], ['underline', 'u']]) {
      await editor.evaluate(element => {
        const range = document.createRange()
        range.selectNodeContents(element)
        const selection = document.getSelection()!
        selection.removeAllRanges()
        selection.addRange(range)
      })
      expect(await page.evaluate(`(${script})(null)`)).toBe(true)
      expect(await page.evaluate(`(${script})('${command}')`)).toBe(true)
      await expect.poll(() => page.evaluate(() => localStorage.getItem('balance.appState.v1'))).toContain(`<${tag}>`)
      expect(await page.evaluate(`(${script})('${command}')`)).toBe(true)
      await expect.poll(() => editor.innerHTML()).not.toMatch(/<(b|strong|i|em|u)>/)
    }
    expect(await page.evaluate(`(${script})('bold')`)).toBe(true)
    await expect.poll(() => page.evaluate(() => localStorage.getItem('balance.appState.v1'))).toContain('<strong>Format this task</strong>')
    await editor.evaluate(() => document.getSelection()!.collapseToEnd())
    expect(await page.evaluate(`(${script})('bold')`)).toBe(false)
    await page.reload()
    if (pageName !== 'Today') {
      if (info.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click()
      await page.getByRole('button', { name: pageName, exact: true }).click()
    }
    await expect(page.locator(selector).first()).toHaveText('Format this task')
    await expect(page.locator(selector).first().locator('strong')).toHaveText('Format this task')
  })
}

test('Android formatting excludes plain inputs and selections crossing task boundaries', async ({ page }) => {
  await page.setContent('<input value="plain"><div contenteditable="true" data-rich-text-input>First</div><div contenteditable="true" data-rich-text-input>Second</div>')
  await page.locator('input').focus()
  expect(await page.evaluate(`(${script})(null)`)).toBe(false)
  await page.locator('div').first().focus()
  await page.evaluate(() => {
    const editors = document.querySelectorAll('div')
    const range = document.createRange()
    range.setStart(editors[0].firstChild!, 0)
    range.setEnd(editors[1].firstChild!, 3)
    document.getSelection()!.addRange(range)
  })
  expect(await page.evaluate(`(${script})('bold')`)).toBe(false)
})
