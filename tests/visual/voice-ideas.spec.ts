import { expect, test, type Page } from '@playwright/test'
import { openView } from '../helpers/navigation'

// Chromium's fake capture device plays a synthetic beep, never a real microphone.
test.use({
  launchOptions: { args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] },
  permissions: ['microphone'],
})

async function state(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let value: any
    plannerStore.subscribe((current: any) => { value = current })()
    return JSON.parse(JSON.stringify({ ideaBuckets: value.ideaBuckets, voiceClips: value.voiceClips }))
  })
}

async function storeCall(page: Page, script: string, arg?: unknown) {
  return page.evaluate(async ({ body, arg }) => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    return new Function('plannerStore', 'arg', body)(plannerStore, arg)
  }, { body: script, arg })
}

async function open(page: Page) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await expect(page.getByRole('region', { name: 'Daily plan' })).toBeVisible()
  await openView(page, 'Ideas')
}

const proposition = (page: Page) => page.locator('.idea-group-card[data-idea-group="proposition"]')

test('a recorded idea persists, waits for transcription and leaves with its idea', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Fake capture devices are Chromium-only')
  await open(page)

  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await expect(proposition(page).getByRole('button', { name: 'Stop recording' })).toBeVisible()
  await page.waitForTimeout(1500)
  await proposition(page).getByRole('button', { name: 'Stop recording' }).click()
  const chip = proposition(page).locator('.voice-clip-chip')
  await expect(chip).toBeVisible()

  let current = await state(page)
  const [clip] = current.voiceClips
  expect(clip.dataURL).toMatch(/^data:audio\/webm;codecs=opus;base64,/)
  expect(clip.durationMs).toBeGreaterThan(1000)
  expect(clip.peaks.length).toBeGreaterThan(15)
  expect(clip.transcript).toBeUndefined()
  expect(current.ideaBuckets[0].items.map((item: any) => item.id)).toEqual([clip.ideaId])

  await page.reload()
  await openView(page, 'Ideas')
  await expect(proposition(page).locator('.voice-clip-chip')).toBeVisible()

  // Untranscribed recordings are skipped by Sort.
  await storeCall(page, "plannerStore.addIdea('Synthetic typed idea')")
  await proposition(page).getByRole('button', { name: 'Sort', exact: true }).click()
  const sorter = page.locator('.idea-sort[role="dialog"]')
  await expect(sorter.getByRole('progressbar', { name: 'Ideas sorted' })).toHaveAttribute('aria-valuemax', '1')
  await page.keyboard.press('Escape')
  await expect(sorter).toBeHidden()

  // A transcript fills the empty idea.
  await storeCall(page, `plannerStore.applyVoiceTranscript(arg, { text: 'Synthetic spoken idea.', words: [
    { text: 'Synthetic', start: 0, end: 0.4 }, { text: 'spoken', start: 0.4, end: 0.8 }, { text: 'idea.', start: 0.8, end: 1.2 },
  ], model: 'test', transcribedAt: '2026-10-27T00:00:00Z' })`, clip.id)
  current = await state(page)
  expect(current.ideaBuckets[0].items[0].text).toBe('Synthetic spoken idea.')

  // Sorting the idea out of Proposition Party deletes its audio; undo brings it back.
  await storeCall(page, "plannerStore.moveIdeaToGroup(arg, 'possible')", clip.ideaId)
  expect((await state(page)).voiceClips).toEqual([])
  await storeCall(page, 'return plannerStore.undo()')
  await expect.poll(async () => (await state(page)).voiceClips.length).toBe(1)
})

test('the transcript and waveform follow each other', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Pointer selection is covered on desktop')
  await open(page)
  // A short real recording stands in for a long one so the waveform must scroll.
  const dataURL = await page.evaluate(async () => {
    const context = new AudioContext()
    const oscillator = context.createOscillator()
    const destination = context.createMediaStreamDestination()
    oscillator.connect(destination)
    oscillator.start()
    const recorder = new MediaRecorder(destination.stream, { mimeType: 'audio/webm;codecs=opus' })
    const chunks: Blob[] = []
    recorder.ondataavailable = (event) => chunks.push(event.data)
    const stopped = new Promise((resolve) => { recorder.onstop = resolve })
    recorder.start()
    await new Promise((resolve) => setTimeout(resolve, 600))
    recorder.stop()
    await stopped
    oscillator.stop()
    const reader = new FileReader()
    return new Promise<string>((resolve) => {
      reader.onload = () => resolve(String(reader.result))
      reader.readAsDataURL(new Blob(chunks, { type: 'audio/webm;codecs=opus' }))
    })
  })
  const words = Array.from({ length: 30 }, (_, index) => ({ text: `word${index}`, start: index, end: index + 0.8 }))
  const ideaId = await storeCall(page, `
    const ideaId = plannerStore.addVoiceIdea({ dataURL: arg.dataURL, durationMs: 30000, peaks: Array.from({ length: 600 }, (_, i) => (i * 37) % 255) })
    return ideaId
  `, { dataURL })
  const clipId = (await state(page)).voiceClips[0].id
  await storeCall(page, `plannerStore.applyVoiceTranscript(arg.clipId, { text: arg.text, words: arg.words, model: 'test', transcribedAt: '2026-10-27T00:00:00Z' })`,
    { clipId, text: words.map((word) => word.text).join(' '), words })

  await proposition(page).locator('.voice-clip-chip').click()
  const dialog = page.getByRole('dialog', { name: 'Voice idea' })
  const textarea = dialog.getByRole('textbox', { name: 'Idea text' })
  const waveform = dialog.getByRole('slider', { name: 'Audio position' })
  await expect(textarea).toHaveValue(/^word0 word1/)

  // Selecting a late word scrolls the waveform to it.
  const text = await textarea.inputValue()
  await textarea.focus()
  await textarea.evaluate((node: HTMLTextAreaElement, range) => {
    node.setSelectionRange(range[0], range[1])
    node.dispatchEvent(new Event('select'))
  }, [text.indexOf('word25'), text.indexOf('word25') + 6])
  await expect(waveform).toHaveAttribute('aria-valuenow', '25')
  // Wait for the smooth scroll to settle.
  await expect.poll(() => waveform.evaluate(async (node) => {
    const before = node.scrollLeft
    await new Promise((resolve) => setTimeout(resolve, 150))
    return before === node.scrollLeft ? before : -1
  })).toBeGreaterThan(0)

  // Clicking the waveform selects the word spoken there.
  const box = (await waveform.boundingBox())!
  const scrollLeft = await waveform.evaluate((node) => node.scrollLeft)
  await page.mouse.click(box.x + 20 * 60 - scrollLeft + 10, box.y + box.height / 2)
  await expect(waveform).toHaveAttribute('aria-valuenow', '20')
  expect(await textarea.evaluate((node: HTMLTextAreaElement) => node.value.slice(node.selectionStart, node.selectionEnd))).toBe('word20')

  // Edits save to the idea.
  await textarea.evaluate((node: HTMLTextAreaElement) => node.setSelectionRange(node.value.length, node.value.length))
  await textarea.pressSequentially(' extra')
  await expect.poll(async () => (await state(page)).ideaBuckets[0].items[0].text).toMatch(/word29 extra$/)

  // Moving it out closes the dialog and deletes the audio.
  await dialog.getByRole('button', { name: 'Trash', exact: true }).click()
  await expect(dialog).toBeHidden()
  const after = await state(page)
  expect(after.voiceClips).toEqual([])
  expect(after.ideaBuckets.find((group: any) => group.kind === 'trash').items[0].id).toBe(ideaId)
})
