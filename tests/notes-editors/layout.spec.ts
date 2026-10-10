import { test, expect } from './harness'
import { item } from '../fixtures/notesCorpus'

// WebKit kept grid rows at their previous height when text rewrapped at a new
// pane width, leaving large gaps or overlapping rows after leaving IMAX.
test('wrapped list rows resize with the pane when IMAX toggles', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  const long = 'A wrapped list row that runs long enough to need several lines in the regular Notes pane but fewer lines once IMAX widens it. '.repeat(2)
  note.items = [
    item({ kind: 'bullet', html: long }),
    item({ kind: 'numbered', html: long }),
    item({ kind: 'checklist', html: long }),
    item({ html: long }),
  ]
  await harness.boot({ notes: [note] })

  const rowsFitText = () => harness.editorRoot().evaluate((root) => Array.from(root.querySelectorAll<HTMLElement>('.note-block'))
    .map((block) => {
      const text = block.querySelector<HTMLElement>(':scope > .note-text')!.getBoundingClientRect()
      const row = block.getBoundingClientRect()
      return { text: Math.round(text.height), fits: row.bottom - text.bottom >= 0 && row.bottom - text.bottom <= 6 }
    }))
  const before = await rowsFitText()
  expect(before.every((row) => row.fits)).toBe(true)

  await harness.page.keyboard.press('Alt+KeyI')
  await expect(harness.page.locator('.app-shell.page-maximized')).toBeVisible()
  await expect.poll(async () => (await rowsFitText())[0].text).toBeLessThan(before[0].text)
  expect((await rowsFitText()).every((row) => row.fits)).toBe(true)

  await harness.page.keyboard.press('Alt+KeyI')
  await expect(harness.page.locator('.app-shell.page-maximized')).toHaveCount(0)
  await expect.poll(async () => (await rowsFitText())[0].text).toBe(before[0].text)
  expect(await rowsFitText()).toEqual(before)
})
