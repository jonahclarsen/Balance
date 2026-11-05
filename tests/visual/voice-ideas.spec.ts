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

const proposition = (page: Page) => page.locator('.ideas-panel')

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
  expect(current.ideaBuckets[0].items.find((item: any) => item.id === clip.ideaId).text).toBe('Synthetic spoken idea.')

  // Sorting the idea out of Proposition Party deletes its audio; undo brings it back.
  await storeCall(page, "plannerStore.moveIdeaToGroup(arg, 'possible')", clip.ideaId)
  expect((await state(page)).voiceClips).toEqual([])
  await storeCall(page, 'return plannerStore.undo()')
  await expect.poll(async () => (await state(page)).voiceClips.length).toBe(1)
})

test('the Android notification stops and saves a recording after leaving Ideas', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Fake capture devices are Chromium-only')
  await page.addInitScript(() => {
    const calls: string[] = []
    ;(window as any).__voiceBridgeCalls = calls
    ;(window as any).BalanceVoiceInput = {
      permissions: () => 'granted',
      requestPermissions: () => {},
      recordingStarted: () => calls.push('started'),
      recordingStopped: () => calls.push('stopped'),
    }
  })
  await open(page)
  const calls = () => page.evaluate(() => (window as any).__voiceBridgeCalls.slice())
  const before = (await calls()).length

  // Discarding also clears the notification.
  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await expect(proposition(page).getByRole('button', { name: 'Stop recording' })).toBeVisible()
  // The controls stay reachable from any group, and a new recording returns to Proposition Party.
  await page.locator('.idea-group-card[data-idea-group="trash"]').click()
  await proposition(page).getByRole('button', { name: 'Discard recording' }).click()
  await expect.poll(async () => (await calls()).slice(before)).toEqual(['started', 'stopped'])

  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await expect(proposition(page).getByRole('button', { name: 'Stop recording' })).toBeVisible()
  await page.waitForTimeout(1200)
  await openView(page, 'Today')
  await page.evaluate(() => window.dispatchEvent(new Event('balance-voice-stop')))

  await expect.poll(async () => (await state(page)).voiceClips.length).toBe(1)
  expect((await state(page)).voiceClips[0].durationMs).toBeGreaterThan(800)
  await expect.poll(async () => (await calls()).slice(before)).toEqual(['started', 'stopped', 'started', 'stopped'])

  await openView(page, 'Ideas')
  await expect(proposition(page).locator('.voice-clip-chip')).toBeVisible()
  await expect(proposition(page).getByRole('button', { name: 'Record an idea' })).toBeEnabled()
})

test('closing the app mid-recording keeps the clip, once', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Fake capture devices are Chromium-only')
  await open(page)

  // A discarded recording stays gone.
  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await expect(proposition(page).getByRole('button', { name: 'Stop recording' })).toBeVisible()
  await page.waitForTimeout(1300)
  await proposition(page).getByRole('button', { name: 'Discard recording' }).click()

  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await expect(proposition(page).getByRole('button', { name: 'Stop recording' })).toBeVisible()
  const startedAt = Date.now()
  await page.waitForTimeout(3300)
  // Closes without stopping the recorder; the Android emulator test kills the process.
  await page.close()

  const reopened = await context.newPage()
  await reopened.goto('/')
  await expect.poll(async () => (await state(reopened)).voiceClips.length).toBe(1)
  const [clip] = (await state(reopened)).voiceClips
  expect(clip.durationMs).toBeGreaterThan(1500)
  expect(clip.peaks.length).toBeGreaterThan(30)
  expect(Math.abs(new Date(clip.createdAt).getTime() - startedAt)).toBeLessThan(3000)
  await openView(reopened, 'Ideas')
  await expect(proposition(reopened).locator('.voice-clip-chip')).toHaveCount(1)

  await reopened.reload()
  await openView(reopened, 'Ideas')
  await expect(proposition(reopened).locator('.voice-clip-chip')).toHaveCount(1)
  expect((await state(reopened)).voiceClips).toHaveLength(1)
})

test('the phone microphone records unprocessed, away from a connected headset', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Fake capture devices are Chromium-only')
  await page.addInitScript(() => {
    const requests: unknown[] = []
    ;(window as any).__micRequests = requests
    ;(window as any).BalanceVoiceInput = {
      permissions: () => 'granted',
      requestPermissions: () => {},
      recordingStarted: () => {},
      recordingStopped: () => {},
    }
    const media = navigator.mediaDevices
    const getUserMedia = media.getUserMedia.bind(media)
    media.getUserMedia = (constraints) => {
      requests.push(constraints)
      return getUserMedia({ audio: true })
    }
    media.enumerateDevices = async () => [
      { kind: 'audioinput', deviceId: 'default', label: 'Default' },
      { kind: 'audioinput', deviceId: 'headset', label: 'Bluetooth headset' },
      { kind: 'audioinput', deviceId: 'phone', label: 'Speakerphone' },
    ] as MediaDeviceInfo[]
  })
  await open(page)
  const headset = proposition(page).getByRole('button', { name: 'Headset microphone' })
  const phone = proposition(page).getByRole('button', { name: 'Phone microphone' })
  const lastRequest = () => page.evaluate(() => (window as any).__micRequests.at(-1))
  const record = async () => {
    await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
    await proposition(page).getByRole('button', { name: 'Discard recording' }).click()
  }
  await expect(headset).toHaveAttribute('aria-pressed', 'true')
  await record()
  // The headset choice keeps the system's processed input; only Android names the headset.
  expect(await lastRequest()).toEqual({ audio: true })

  await phone.click()
  await record()
  expect(await lastRequest()).toEqual({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'phone' } } })

  // The choice lasts, and later recordings ask for the phone from the start.
  await page.reload()
  await openView(page, 'Ideas')
  await expect(phone).toHaveAttribute('aria-pressed', 'true')
  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await proposition(page).getByRole('button', { name: 'Discard recording' }).click()
  const first = await page.evaluate(() => (window as any).__micRequests[0])
  expect(first.audio.deviceId).toEqual({ ideal: 'phone' })
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
  // Wait for the smooth scroll to center the word; a busy machine can stall it midway.
  await expect.poll(() => waveform.evaluate((node) => Math.abs(node.scrollLeft - (25 * 60 - node.clientWidth / 2)))).toBeLessThan(2)

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

test('a transcript goes below text typed on its idea', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Store behavior is covered on desktop')
  await open(page)
  const transcript = { text: 'Synthetic spoken idea.', words: [
    { text: 'Synthetic', start: 0, end: 0.4 }, { text: 'spoken', start: 0.4, end: 0.8 }, { text: 'idea.', start: 0.8, end: 1.2 },
  ], model: 'test', transcribedAt: '2026-10-27T00:00:00Z' }
  const ideaId = await storeCall(page, "return plannerStore.addVoiceIdea({ dataURL: 'data:audio/webm;base64,', durationMs: 1200, peaks: [10, 200, 90] })")
  const groupId = (await state(page)).ideaBuckets.find((group: any) => group.kind === 'proposition').id
  const clipId = (await state(page)).voiceClips[0].id
  const idea = async () => (await state(page)).ideaBuckets.find((group: any) => group.id === groupId).items[0]
  await storeCall(page, "plannerStore.patchIdeaItem(arg.groupId, arg.ideaId, { text: 'Typed first', html: 'Typed first' })", { groupId, ideaId })

  // The clip sits inside its idea's row.
  await expect(proposition(page).locator('.plan-row .voice-clip-chip')).toBeVisible()

  await storeCall(page, 'plannerStore.applyVoiceTranscript(arg.clipId, arg.transcript)', { clipId, transcript })
  expect(await idea()).toMatchObject({ text: 'Typed first\nSynthetic spoken idea.', html: 'Typed first<br>Synthetic spoken idea.' })
  // Applying it again doesn't duplicate it.
  await storeCall(page, 'plannerStore.applyVoiceTranscript(arg.clipId, arg.transcript)', { clipId, transcript })
  expect((await idea()).text).toBe('Typed first\nSynthetic spoken idea.')

  // A transcript missing from the text can be added back from the dialog.
  await storeCall(page, "plannerStore.patchIdeaItem(arg.groupId, arg.ideaId, { text: 'Typed only', html: 'Typed only' })", { groupId, ideaId })
  await proposition(page).locator('.voice-clip-chip').click()
  const dialog = page.getByRole('dialog', { name: 'Voice idea' })
  await dialog.getByRole('button', { name: 'Transcribe', exact: true }).click()
  await expect(dialog.getByRole('textbox', { name: 'Idea text' })).toHaveValue('Typed only\nSynthetic spoken idea.')
  await expect(dialog.getByRole('button', { name: 'Transcribe', exact: true })).toBeHidden()
  expect((await idea()).text).toBe('Typed only\nSynthetic spoken idea.')
})
