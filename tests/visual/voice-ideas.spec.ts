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

function silentWav(seconds: number, sampleRate = 8000): Buffer {
  const samples = seconds * sampleRate
  const wav = Buffer.alloc(44 + samples, 128)
  wav.write('RIFF', 0)
  wav.writeUInt32LE(36 + samples, 4)
  wav.write('WAVEfmt ', 8)
  wav.writeUInt32LE(16, 16)
  wav.writeUInt16LE(1, 20)
  wav.writeUInt16LE(1, 22)
  wav.writeUInt32LE(sampleRate, 24)
  wav.writeUInt32LE(sampleRate, 28)
  wav.writeUInt16LE(1, 32)
  wav.writeUInt16LE(8, 34)
  wav.write('data', 36)
  wav.writeUInt32LE(samples, 40)
  return wav
}

test('a recorded idea persists, sorts before transcription and leaves with its idea', async ({ page }, testInfo) => {
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

  // Sort offers untranscribed recordings too, holding back choices that
  // would take the audio out of the idea groups.
  await storeCall(page, "plannerStore.addIdea('Synthetic typed idea')")
  await proposition(page).getByRole('button', { name: 'Sort', exact: true }).click()
  const sorter = page.locator('.idea-sort[role="dialog"]')
  await expect(sorter.getByRole('progressbar', { name: 'Ideas sorted' })).toHaveAttribute('aria-valuemax', '2')
  // The older recording comes first.
  await expect(sorter.locator('.voice-clip-chip')).toBeVisible()
  await page.keyboard.press('y')
  await expect(sorter.getByRole('button', { name: /^Possibly/ })).toBeVisible()
  await expect(sorter.getByRole('button', { name: 'Cut (X)' })).toHaveCount(0)
  await expect(sorter.getByRole('button', { name: 'Add to new note (N)' })).toHaveCount(0)
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

  // The controls stay reachable from any group, and a new recording returns to Proposition Party.
  await page.locator('.idea-group-card[data-idea-group="trash"]').click()
  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await expect(proposition(page).getByRole('button', { name: 'Stop recording' })).toBeVisible()
  await page.waitForTimeout(1200)
  await openView(page, 'Today')
  await page.evaluate(() => window.dispatchEvent(new Event('balance-voice-stop')))

  await expect.poll(async () => (await state(page)).voiceClips.length).toBe(1)
  expect((await state(page)).voiceClips[0].durationMs).toBeGreaterThan(800)
  await expect.poll(async () => (await calls()).slice(before)).toEqual(['started', 'stopped'])

  await openView(page, 'Ideas')
  await expect(proposition(page).locator('.voice-clip-chip')).toBeVisible()
  await expect(proposition(page).getByRole('button', { name: 'Record an idea' })).toBeEnabled()
})

test('closing the app mid-recording keeps the clip, once', async ({ page, context }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Fake capture devices are Chromium-only')
  await open(page)

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

test('the microphone switches mid-recording, to the phone unprocessed', async ({ page }, testInfo) => {
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
  const stop = proposition(page).getByRole('button', { name: 'Stop recording' })
  const requests = () => page.evaluate(() => (window as any).__micRequests.slice())

  // The choice only shows while recording.
  await expect(phone).toHaveCount(0)
  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await expect(headset).toHaveAttribute('aria-pressed', 'true')
  // The headset keeps the system's processed input.
  expect(await requests()).toEqual([{ audio: { deviceId: { exact: 'headset' } } }])
  await expect(proposition(page).locator('.voice-waveform')).toBeVisible()
  await page.waitForTimeout(1200)

  await phone.click()
  await expect(phone).toHaveAttribute('aria-pressed', 'true')
  await expect(phone).toBeEnabled()
  expect((await requests()).at(-1)).toEqual({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'phone' } } })
  await page.waitForTimeout(1200)
  await stop.click()

  // One clip spans both microphones.
  await expect.poll(async () => (await state(page)).voiceClips.length).toBe(1)
  expect((await state(page)).voiceClips[0].durationMs).toBeGreaterThan(2000)
  await expect(phone).toHaveCount(0)

  // The choice lasts, and later recordings ask for the phone from the start.
  await page.reload()
  await openView(page, 'Ideas')
  const before = (await requests()).length
  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await expect(phone).toHaveAttribute('aria-pressed', 'true')
  expect((await requests())[before].audio.deviceId).toEqual({ ideal: 'phone' })
  await stop.click()
})

test('without a Bluetooth microphone, the phone records and shows as chosen', async ({ page }, testInfo) => {
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
      { kind: 'audioinput', deviceId: 'phone', label: 'Speakerphone' },
    ] as MediaDeviceInfo[]
  })
  await open(page)
  const headset = proposition(page).getByRole('button', { name: 'Headset microphone' })
  const phone = proposition(page).getByRole('button', { name: 'Phone microphone' })

  await proposition(page).getByRole('button', { name: 'Record an idea' }).click()
  await expect(phone).toHaveAttribute('aria-pressed', 'true')
  await expect(headset).toBeDisabled()
  const requests = await page.evaluate(() => (window as any).__micRequests.slice())
  expect(requests.at(-1)).toEqual({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, deviceId: { exact: 'phone' } } })
  // The live waveform moves with the fake device's beep.
  const bars = proposition(page).locator('.voice-waveform span')
  await expect.poll(() => bars.evaluateAll((spans) => spans.filter((span) => span.getBoundingClientRect().height > 2).length)).toBeGreaterThan(0)
  await page.waitForTimeout(1200)
  await proposition(page).getByRole('button', { name: 'Stop recording' }).click()
  await expect.poll(async () => (await state(page)).voiceClips.length).toBe(1)
})

test('the Add idea dialog records an idea with its typed text', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Fake capture devices are Chromium-only')
  await open(page)
  await openView(page, 'Today')
  await page.keyboard.press('Alt+KeyA')
  const dialog = page.getByRole('dialog', { name: 'Add idea' })
  await expect(dialog).toBeVisible()
  await page.keyboard.type('Synthetic typed words')
  await dialog.getByRole('button', { name: 'Record an idea' }).click()
  await expect(dialog.getByRole('button', { name: 'Stop recording' })).toBeVisible()
  // Recording leaves only Save and Stop: closing would save too.
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
  await page.waitForTimeout(1200)
  await dialog.getByRole('button', { name: 'Stop recording' }).click()
  await expect(dialog).toBeHidden()

  await expect.poll(async () => (await state(page)).voiceClips.length).toBe(1)
  const current = await state(page)
  const idea = current.ideaBuckets[0].items.find((item: any) => item.id === current.voiceClips[0].ideaId)
  expect(idea.text).toBe('Synthetic typed words')

  // Escape mid-recording keeps the audio.
  await page.keyboard.press('Alt+KeyA')
  await dialog.getByRole('button', { name: 'Record an idea' }).click()
  await expect(dialog.getByRole('button', { name: 'Stop recording' })).toBeVisible()
  await page.waitForTimeout(1200)
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect.poll(async () => (await state(page)).voiceClips.length).toBe(2)
})

test('the transcript and waveform follow each other', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'Pointer selection is covered on desktop')
  await open(page)
  // Thirty seconds of silence, long enough to play through and scroll.
  const dataURL = `data:audio/wav;base64,${silentWav(30).toString('base64')}`
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

  // Clicking the waveform moves the playhead and marks the word, without selecting it.
  const box = (await waveform.boundingBox())!
  const scrollLeft = await waveform.evaluate((node) => node.scrollLeft)
  await page.mouse.click(box.x + 20 * 60 - scrollLeft + 10, box.y + box.height / 2)
  await expect(waveform).toHaveAttribute('aria-valuenow', '20')
  await expect(dialog.locator('.voice-idea-mirror mark')).toHaveText('word20')

  // Selected text plays from its start to the end, not just the selection.
  await textarea.evaluate((node: HTMLTextAreaElement, at) => {
    node.setSelectionRange(at, at + 5)
    node.dispatchEvent(new Event('select'))
  }, text.indexOf('word2 '))
  await expect(waveform).toHaveAttribute('aria-valuenow', '2')
  await dialog.getByRole('button', { name: 'Play' }).click()
  await expect.poll(() => waveform.getAttribute('aria-valuenow').then(Number), { timeout: 5000 }).toBeGreaterThanOrEqual(4)
  await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible()

  // Tapping a word while it plays jumps playback there.
  await textarea.evaluate((node: HTMLTextAreaElement, at) => {
    node.setSelectionRange(at, at)
    node.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, text.indexOf('word15') + 2)
  await expect.poll(() => waveform.getAttribute('aria-valuenow').then(Number)).toBeGreaterThanOrEqual(15)
  await expect(dialog.getByRole('button', { name: 'Pause' })).toBeVisible()

  // Scrolling the waveform while it plays stays where it was put.
  await waveform.evaluate((node) => node.dispatchEvent(new WheelEvent('wheel', { deltaX: -400 })))
  await waveform.evaluate((node) => { node.scrollLeft = 0 })
  await page.waitForTimeout(500)
  expect(await waveform.evaluate((node) => node.scrollLeft)).toBe(0)
  await dialog.getByRole('button', { name: 'Pause' }).click()

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

test('a sorted voice idea shows its clip and opens the voice dialog', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name === 'mobile', 'The shared dialog is covered on desktop')
  await open(page)
  const transcript = { text: 'Synthetic spoken idea.', words: [
    { text: 'Synthetic', start: 0, end: 0.4 }, { text: 'spoken', start: 0.4, end: 0.8 }, { text: 'idea.', start: 0.8, end: 1.2 },
  ], model: 'test', transcribedAt: '2026-10-27T00:00:00Z' }
  await storeCall(page, "plannerStore.addVoiceIdea({ dataURL: 'data:audio/webm;base64,', durationMs: 1200, peaks: [10, 200, 90] })")
  const clipId = (await state(page)).voiceClips[0].id
  await storeCall(page, 'plannerStore.applyVoiceTranscript(arg.clipId, arg.transcript)', { clipId, transcript })

  await proposition(page).getByRole('button', { name: 'Sort', exact: true }).click()
  const sorter = page.locator('.idea-sort[role="dialog"]')
  await sorter.locator('.voice-clip-chip').click()
  const dialog = page.getByRole('dialog', { name: 'Voice idea' })
  await expect(dialog.getByRole('textbox', { name: 'Idea text' })).toHaveValue('Synthetic spoken idea.')
  // Sorting decides with its own choices.
  await expect(dialog.getByRole('group', { name: 'Move idea to' })).toHaveCount(0)

  // Typing in the dialog edits the idea instead of answering the sort.
  await dialog.getByRole('textbox', { name: 'Idea text' }).press('End')
  await dialog.getByRole('textbox', { name: 'Idea text' }).pressSequentially(' yes')
  await expect.poll(async () => (await state(page)).ideaBuckets[0].items[0].text).toBe('Synthetic spoken idea. yes')
  await expect(sorter.getByRole('button', { name: 'Yes (Y)' })).toBeVisible()

  // Escape closes only the voice dialog.
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(sorter).toBeVisible()
  await expect(sorter.locator('.paste-review-text')).toHaveText('Synthetic spoken idea. yes')
})

test('undo passes a transcript by', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Store behavior is covered on desktop')
  await open(page)
  await storeCall(page, "plannerStore.addVoiceIdea({ dataURL: 'data:audio/webm;base64,', durationMs: 1200, peaks: [10, 200, 90] })")
  const clipId = (await state(page)).voiceClips[0].id
  await storeCall(page, "plannerStore.applyVoiceTranscript(arg, { text: 'Synthetic spoken idea.', words: [], model: 'test', transcribedAt: '2026-10-27T00:00:00Z' })", clipId)
  expect((await state(page)).voiceClips[0].transcript.text).toBe('Synthetic spoken idea.')
  await storeCall(page, 'return plannerStore.undo()')
  // The recording itself was the last edit.
  await expect.poll(async () => (await state(page)).voiceClips).toEqual([])
})

for (const failure of ['on startup', 'mid-recording'] as const) {
  test(`AirPods fall back to the phone ${failure} without requesting a hands-free mic`, async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== 'desktop', 'Fake capture devices are Chromium-only')
    await page.addInitScript((failure) => {
      const requests: MediaStreamConstraints[] = []
      const capture = { fail: failure === 'on startup', starts: 0, stops: 0, requests }
      const samples = new Int16Array(65 * 64)
      for (let i = 0; i < samples.length; i++) samples[i] = Math.sin(i / 20) * 8192
      const pcm = btoa(String.fromCharCode(...new Uint8Array(samples.buffer)))
      Object.assign(window, {
        airPodsTest: capture,
        BalanceVoiceInput: {
          permissions: () => 'granted',
          requestPermissions: () => {},
          recordingStarted: () => {},
          recordingStopped: () => {},
          airPodsAvailable: () => true,
          startAirPodsMic: () => { capture.starts++; return true },
          readAirPodsMic: () => capture.fail ? null : `64000:${pcm}`,
          stopAirPodsMic: () => { capture.stops++ },
        },
      })
      const media = navigator.mediaDevices
      const getUserMedia = media.getUserMedia.bind(media)
      media.getUserMedia = (constraints = {}) => {
        requests.push(constraints)
        return getUserMedia({ audio: true })
      }
      media.enumerateDevices = async () => [
        { kind: 'audioinput', deviceId: 'headset', label: 'Bluetooth headset' },
        { kind: 'audioinput', deviceId: 'phone', label: 'Speakerphone' },
      ] as MediaDeviceInfo[]
    }, failure)
    await open(page)
    const ideas = proposition(page)
    const fallback = ideas.getByText('AirPods mic unavailable. Using phone mic.')
    await ideas.getByRole('button', { name: 'Record an idea' }).click()
    if (failure === 'mid-recording') {
      await expect(ideas.getByRole('button', { name: 'Headset microphone' })).toHaveAttribute('aria-pressed', 'true')
      await expect(fallback).toHaveCount(0)
      const bars = ideas.locator('.voice-waveform span')
      await expect.poll(() => bars.evaluateAll((spans) => spans.some((span) => span.getBoundingClientRect().height > 2))).toBe(true)
      await page.evaluate(() => { (window as any).airPodsTest.fail = true })
    }
    await expect(fallback).toBeVisible()
    await expect(ideas.getByRole('button', { name: 'Phone microphone' })).toHaveAttribute('aria-pressed', 'true')
    const capture = await page.evaluate(() => (window as any).airPodsTest)
    expect(capture.starts).toBe(1)
    expect(capture.stops).toBe(1)
    // Every WebView capture is unprocessed, so none opens the hands-free route.
    expect(capture.requests.length).toBeGreaterThan(0)
    for (const request of capture.requests) expect(request.audio).toMatchObject({ echoCancellation: false })
    expect(capture.requests.map((request: any) => request.audio.deviceId)).not.toContainEqual({ exact: 'headset' })
    await page.waitForTimeout(500)
    await ideas.getByRole('button', { name: 'Stop recording' }).click()
    await expect.poll(async () => (await state(page)).voiceClips.length).toBe(1)
  })
}

// A second of synthetic tone, as a WAV the WebView decodes like a recording.
async function addTranscribedVoiceIdea(page: Page) {
  await page.evaluate(async () => {
    const rate = 48_000
    const pcm = new Int16Array(rate)
    for (let index = 0; index < pcm.length; index += 1) pcm[index] = Math.round(8000 * Math.sin((2 * Math.PI * 330 * index) / rate))
    const header = new DataView(new ArrayBuffer(44))
    const text = (offset: number, value: string) => [...value].forEach((character, index) => header.setUint8(offset + index, character.charCodeAt(0)))
    text(0, 'RIFF'); header.setUint32(4, 36 + pcm.byteLength, true); text(8, 'WAVEfmt ')
    header.setUint32(16, 16, true); header.setUint16(20, 1, true); header.setUint16(22, 1, true)
    header.setUint32(24, rate, true); header.setUint32(28, rate * 2, true); header.setUint16(32, 2, true); header.setUint16(34, 16, true)
    text(36, 'data'); header.setUint32(40, pcm.byteLength, true)
    const bytes = new Uint8Array([...new Uint8Array(header.buffer), ...new Uint8Array(pcm.buffer)])
    let binary = ''
    for (const byte of bytes) binary += String.fromCharCode(byte)
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    plannerStore.addVoiceIdea({ dataURL: `data:audio/wav;base64,${btoa(binary)}`, durationMs: 1000, peaks: Array.from({ length: 20 }, (_, index) => index * 12) })
    let clipId = ''
    plannerStore.subscribe((state: any) => { clipId = state.voiceClips[0].id })()
    plannerStore.applyVoiceTranscript(clipId, { text: 'Synthetic spoken idea.', words: [], model: 'test', transcribedAt: '2026-10-27T00:00:00Z' })
  })
}

async function notesAndAudio(page: Page): Promise<any> {
  return page.evaluate(async () => {
    const path = '/src/lib/store.ts'
    const { plannerStore } = await import(/* @vite-ignore */ path)
    let value: any
    plannerStore.subscribe((current: any) => { value = current })()
    return JSON.parse(JSON.stringify({ notes: value.notes, audio: value.audio, voiceClips: value.voiceClips }))
  })
}

test('Add to new note asks whether the recording comes along, as 64 kbps Opus', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'WebCodecs encoding is covered on desktop Chromium')
  await open(page)
  await addTranscribedVoiceIdea(page)
  await proposition(page).getByRole('button', { name: 'Sort', exact: true }).click()
  const sorter = page.locator('.idea-sort[role="dialog"]')
  await page.keyboard.press('y')
  await page.keyboard.press('n')
  await expect(sorter.getByText('Include the recording?')).toBeVisible()
  // Back returns to the Yes choices.
  await page.keyboard.press('b')
  await expect(sorter.getByRole('button', { name: 'Add to new note (N)' })).toBeVisible()
  await page.keyboard.press('n')
  await page.keyboard.press('y')
  await expect(sorter).toBeHidden()

  const saved = await notesAndAudio(page)
  expect(saved.voiceClips).toEqual([])
  expect(saved.audio).toHaveLength(1)
  const [asset] = saved.audio
  expect(asset.dataURL).toMatch(/^data:audio\/ogg;codecs=opus;base64,/)
  // About 8 KB for a second at 64 kbps, plus headers.
  expect(asset.bytes).toBeGreaterThan(4_000)
  expect(asset.bytes).toBeLessThan(12_000)
  expect(saved.notes[0].items[0].html).toBe(`Synthetic spoken idea. <span data-balance-audio="${asset.id}"></span>`)

  await openView(page, 'Notes')
  const chip = page.locator('.lexical-note-editor .audio-chip')
  await expect(chip.getByRole('button', { name: 'Play recording, 0:01' })).toBeVisible()
  await chip.getByRole('button').click()
  await expect(chip).toHaveClass(/playing/)
  await expect(chip).not.toHaveClass(/playing/, { timeout: 5000 })

  // Undo puts the idea and its recording back and removes the note's copy.
  await storeCall(page, 'return plannerStore.undo()')
  await expect.poll(async () => {
    const current = await notesAndAudio(page)
    return [current.audio.length, current.voiceClips.length]
  }).toEqual([0, 1])
})

test('declining the recording adds only the text to the note', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop', 'Store behavior is covered on desktop')
  await open(page)
  await addTranscribedVoiceIdea(page)
  await proposition(page).getByRole('button', { name: 'Sort', exact: true }).click()
  await page.keyboard.press('y')
  await page.keyboard.press('n')
  await page.keyboard.press('n')
  await expect(page.locator('.idea-sort[role="dialog"]')).toBeHidden()
  const saved = await notesAndAudio(page)
  expect(saved.audio).toEqual([])
  expect(saved.voiceClips).toEqual([])
  expect(saved.notes[0].items[0].text).toBe('Synthetic spoken idea.')
})
