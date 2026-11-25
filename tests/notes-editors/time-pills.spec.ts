import { expect, mod, test } from './harness'
import { noteTimeHTML } from '../../src/lib/noteTimeMarkup'

const TEXT = 'First paragraph with plain text.'

test.beforeEach(async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-24T10:07:00'))
})

test('Alt+Shift+T adds a time pill at the caret, keys adjust it, and it deletes like a character', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  const id = note.items[0].id
  await harness.boot({ notes: [note] })
  await harness.placeCaret(id, 5)
  await harness.page.keyboard.press('Alt+Shift+T')
  await harness.page.keyboard.type(' at')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === `First${noteTimeHTML(600, 660)} at paragraph with plain text.`)
  expect((await harness.storedNote(note.id))!.items[0].text).toBe('First10am–11am at paragraph with plain text.')

  // The caret sits after " at"; the keys act on the pill before it.
  await harness.page.keyboard.press('Alt+BracketRight')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html.includes(noteTimeHTML(615, 660)))
  await harness.page.keyboard.press(`${mod}+BracketRight`)
  await harness.waitForNote(note.id, (stored) => stored.items[0].html.includes(noteTimeHTML(615, 675)))
  await harness.page.keyboard.press(`${mod}+Shift+BracketLeft`)
  await harness.waitForNote(note.id, (stored) => stored.items[0].html.includes(noteTimeHTML(600, 660)))

  await harness.page.keyboard.press('Backspace')
  await harness.page.keyboard.press('Backspace')
  await harness.page.keyboard.press('Backspace')
  await harness.page.keyboard.press('Backspace')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === TEXT)
})

test('Alt+Shift+T beside a pill removes it, and a second pill follows the first', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  const id = note.items[0].id
  await harness.boot({ notes: [note] })
  await harness.placeCaret(id, TEXT.length)
  await harness.page.keyboard.press('Alt+Shift+T')
  await harness.page.keyboard.type(' then ')
  await harness.page.keyboard.press('Alt+Shift+T')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === `${TEXT}${noteTimeHTML(600, 660)} then ${noteTimeHTML(660, 720)}`)
  await harness.page.keyboard.press('Alt+Shift+T')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === `${TEXT}${noteTimeHTML(600, 660)} then `)
})

test('dragging a pill moves it; Alt drags only the start; undo restores it', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = `Meet ${noteTimeHTML(540, 600)} here`
  note.items[0].text = 'Meet 9am–10am here'
  await harness.boot({ notes: [note] })
  const pill = harness.block(note.items[0].id).locator('time.note-time')
  await expect(pill).toHaveText('9am-10am')

  const drag = async (edge: 'start' | 'end', dy: number, alt = false) => {
    const box = (await pill.locator(`[data-note-time-edge="${edge}"]`).boundingBox())!
    const x = box.x + box.width / 2
    const y = box.y + box.height / 2
    await harness.page.mouse.move(x, y)
    if (alt) await harness.page.keyboard.down('Alt')
    await harness.page.mouse.down()
    for (let step = 1; step <= 4; step += 1) await harness.page.mouse.move(x, y + (dy * step) / 4)
    await harness.page.mouse.up()
    if (alt) await harness.page.keyboard.up('Alt')
  }

  await drag('start', -20)
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === `Meet ${noteTimeHTML(570, 630)} here`)
  await drag('end', -10)
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === `Meet ${noteTimeHTML(570, 645)} here`)
  await drag('start', 10, true)
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === `Meet ${noteTimeHTML(555, 645)} here`)

  await harness.undo()
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === `Meet ${noteTimeHTML(570, 645)} here`)
})

test('arrow keys step over a pill like one character, and the toolbar adds one', async ({ harness }) => {
  const note = harness.noteByTitle('Simple paragraphs')
  note.items[0].html = `Standup ${noteTimeHTML(540, 570)} then`
  note.items[0].text = 'Standup 9am–9:30am then'
  await harness.boot({ notes: [note] })
  await harness.placeCaret(note.items[0].id, 'Standup '.length)
  await harness.page.keyboard.press('ArrowRight')
  await harness.page.keyboard.type('X')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === `Standup ${noteTimeHTML(540, 570)}X then`)
  await harness.page.keyboard.press('ArrowLeft')
  await harness.page.keyboard.press('ArrowLeft')
  await harness.page.keyboard.press('Shift+ArrowRight')
  await harness.page.keyboard.type('Y')
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === 'Standup YX then')

  await harness.page.getByRole('button', { name: 'Time', exact: true }).click()
  await harness.waitForNote(note.id, (stored) => stored.items[0].html === `Standup Y${noteTimeHTML(600, 660)}X then`)
})
