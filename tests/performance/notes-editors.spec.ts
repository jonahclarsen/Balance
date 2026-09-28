// Head-to-head profile of the Notes page editors (Classic, TipTap, Lexical).
// Every scenario runs identically against the editor named by
// BALANCE_NOTES_PERF_EDITOR on a synthetic note corpus, under Chromium CPU
// throttling, and prints one `NOTES_EDITOR_PERF {json}` line for CI to collect.

import { test, type CDPSession, type Page } from '@playwright/test'
import type { Note, NoteItem, NoteItemKind } from '../../src/lib/types'

type EditorName = 'classic' | 'tiptap' | 'lexical'

const EDITOR = (process.env.BALANCE_NOTES_PERF_EDITOR ?? 'classic') as EditorName
const CPU_RATE = performanceSize('BALANCE_NOTES_PERF_CPU_RATE', 4)
const LARGE_BLOCKS = performanceSize('BALANCE_NOTES_PERF_LARGE_BLOCKS', 1_000)
const MEDIUM_BLOCKS = performanceSize('BALANCE_NOTES_PERF_MEDIUM_BLOCKS', 150)
const SWITCH_ROUNDS = performanceSize('BALANCE_NOTES_PERF_SWITCHES', 8)
const TYPED_TEXT = 'The quick brown fox jumps over the lazy dog while notes stay fast. '.repeat(2)
const SPLIT_COUNT = performanceSize('BALANCE_NOTES_PERF_SPLITS', 15)
const PASTE_BLOCKS = performanceSize('BALANCE_NOTES_PERF_PASTE_BLOCKS', 100)

const STATE_KEY = 'balance.appState.v1'
const EDITOR_KEY = 'balance:noteEditor.v1'

function performanceSize(variable: string, fallback: number) {
  const value = Number(process.env[variable])
  return Number.isFinite(value) && value > 0 ? value : fallback
}

function percentile(values: number[], fraction: number) {
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0
}

function summarize(values: number[]) {
  const round = (value: number) => Math.round(value * 10) / 10
  return {
    count: values.length,
    medianMs: round(percentile(values, 0.5)),
    p95Ms: round(percentile(values, 0.95)),
    maxMs: round(Math.max(0, ...values)),
  }
}

// ---- Synthetic corpus -------------------------------------------------------

const INLINE_VARIANTS = [
  (n: number) => `Plain paragraph number ${n} with enough words to wrap across a typical editor width.`,
  (n: number) => `Paragraph ${n} with <strong>bold</strong>, <em>italic</em>, and <u>underlined</u> runs mixed in.`,
  (n: number) => `Reference ${n}: <a href="https://example.com/${n}" target="_blank" rel="noreferrer">example.com/${n}</a> then text.`,
  (n: number) => `Nested <strong>bold <em>and italic ${n}</em></strong> with a line<br>break inside the block.`,
]

function textFromHTML(html: string) {
  return html.replace(/<br\s*\/?>/g, '').replace(/<[^>]+>/g, '')
}

function createItem(id: string, kind: NoteItemKind, html: string, children: NoteItem[] = [], done = false): NoteItem {
  return { id, kind, text: textFromHTML(html), html, done, startMinutes: null, endMinutes: null, children }
}

// Returns the note plus the id of a childless paragraph near its middle, which
// is where the typing, splitting and paste scenarios place the caret.
function createNote(prefix: string, title: string, blockCount: number, updatedDay: number) {
  let serial = 0
  let total = 0
  let middleLeafId = ''
  const nextId = () => `${prefix}_${String(++serial).padStart(5, '0')}`
  const items: NoteItem[] = []
  while (total < blockCount) {
    const n = total
    const section = Math.floor(n / 20) % 5
    if (n % 20 === 0) {
      items.push(createItem(nextId(), 'heading', `Section ${n / 20 + 1}`))
      total += 1
    } else if (section === 1 || section === 3) {
      const kind: NoteItemKind = section === 1 ? 'bullet' : 'numbered'
      const children = [0, 1].map((offset) => createItem(nextId(), kind, `Nested ${kind} ${n}.${offset}`))
      items.push(createItem(nextId(), kind, `${kind} item ${n} with a couple of nested children`, children))
      total += 3
    } else if (section === 2) {
      items.push(createItem(nextId(), 'checklist', `Checklist entry ${n}`, [], n % 3 === 0))
      total += 1
    } else if (n % 7 === 0) {
      items.push(createItem(nextId(), 'quote', `Quoted passage ${n}, set apart from the paragraphs around it.`))
      total += 1
    } else {
      const id = nextId()
      items.push(createItem(id, 'paragraph', INLINE_VARIANTS[n % INLINE_VARIANTS.length](n)))
      if (!middleLeafId && total >= blockCount / 2) middleLeafId = id
      total += 1
    }
  }
  const stamp = new Date(Date.UTC(2026, 0, updatedDay, 9)).toISOString()
  const note: Note = { id: `${prefix}_note`, title, items, createdAt: stamp, updatedAt: stamp, deletedAt: null }
  const flat = (list: NoteItem[]): NoteItem[] => list.flatMap((item) => [item, ...flat(item.children)])
  return { note, middleLeafId, firstId: items[0].id, lastId: flat(items).at(-1)!.id }
}

// ---- Editor-agnostic DOM access ------------------------------------------

function blockSelector(itemId?: string) {
  if (EDITOR === 'classic') return itemId ? `[data-note-item-id="${itemId}"]` : '[data-note-item-id]'
  return itemId ? `[data-note-editor="${EDITOR}"] [data-item-id="${itemId}"]` : `[data-note-editor="${EDITOR}"] [data-item-id]`
}

async function boot(page: Page, notes: Note[]) {
  await page.goto('/')
  await page.evaluate(() => localStorage.clear())
  await page.reload()
  await page.evaluate(([key, editorKey, editor, seeded]) => {
    const state = JSON.parse(localStorage.getItem(key) || '{}')
    state.notes = seeded
    localStorage.setItem(key, JSON.stringify(state))
    localStorage.setItem(editorKey, editor)
  }, [STATE_KEY, EDITOR_KEY, EDITOR, notes] as const)
  await page.reload()
  await page.getByRole('button', { name: 'Notes', exact: true }).click()
  await page.locator('.note-card').first().waitFor()
}

// Clicks a note card and resolves once the target note's last block has been
// rendered and the following frame has been produced.
async function openNote(page: Page, title: string, lastSelector: string) {
  return page.evaluate(async ([noteTitle, selector]) => {
    const card = Array.from(document.querySelectorAll<HTMLElement>('.note-card'))
      .find((candidate) => candidate.querySelector('strong')?.textContent?.trim() === noteTitle)
    if (!card) throw new Error(`No note card titled ${noteTitle}`)
    card.scrollIntoView({ block: 'nearest' })
    const started = performance.now()
    card.click()
    await new Promise<void>((resolve, reject) => {
      const tick = () => {
        if (document.querySelector(selector)) resolve()
        else if (performance.now() - started > 30_000) reject(new Error(`Timed out rendering ${noteTitle}`))
        else requestAnimationFrame(tick)
      }
      tick()
    })
    await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)))
    return performance.now() - started
  }, [title, lastSelector] as const)
}

async function placeCaretAtEnd(page: Page, itemId: string) {
  await page.locator(blockSelector(itemId)).first().scrollIntoViewIfNeeded()
  await page.evaluate((selector) => {
    const block = document.querySelector<HTMLElement>(selector)
    if (!block) throw new Error(`Missing block ${selector}`)
    const editable = block.querySelector<HTMLElement>('[contenteditable="true"]')
      ?? block.closest<HTMLElement>('[contenteditable="true"]')
    if (!editable) throw new Error('Block has no editable surface')
    editable.focus()
    const textRoot = editable.contains(block) ? block : editable
    const range = document.createRange()
    range.selectNodeContents(textRoot)
    range.collapse(false)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
  }, blockSelector(itemId))
}

// Input-to-next-frame latency: from each keydown's timestamp until the task
// after the next animation frame, which includes the editor's handling, Svelte
// updates, style, layout and paint for that keystroke.
async function installKeyLatencyProbe(page: Page) {
  await page.evaluate(() => {
    const probe = { samples: [] as Array<{ key: string; ms: number }> }
    ;(window as unknown as { __notesPerf: typeof probe }).__notesPerf = probe
    window.addEventListener('keydown', (event) => {
      const started = event.timeStamp
      const key = event.key
      requestAnimationFrame(() => {
        const channel = new MessageChannel()
        channel.port1.onmessage = () => probe.samples.push({ key, ms: performance.now() - started })
        channel.port2.postMessage(null)
      })
    }, true)
  })
}

async function takeKeySamples(page: Page) {
  return page.evaluate(() => {
    const probe = (window as unknown as { __notesPerf: { samples: Array<{ key: string; ms: number }> } }).__notesPerf
    const samples = probe.samples
    probe.samples = []
    return samples
  })
}

async function metrics(session: CDPSession) {
  const { metrics: list } = await session.send('Performance.getMetrics')
  return Object.fromEntries(list.map((metric) => [metric.name, metric.value])) as Record<string, number>
}

async function heapAndNodes(session: CDPSession) {
  await session.send('HeapProfiler.collectGarbage')
  const values = await metrics(session)
  return { jsHeapMb: Math.round((values.JSHeapUsedSize / 1_048_576) * 10) / 10, domNodes: values.Nodes }
}

// Runs an action and reports main-thread task time it consumed (CDP
// TaskDuration is in seconds of throttled renderer time).
async function taskTime<T>(session: CDPSession, action: () => Promise<T>) {
  const before = (await metrics(session)).TaskDuration
  const result = await action()
  const after = (await metrics(session)).TaskDuration
  return { result, taskMs: Math.round((after - before) * 1000 * 10) / 10 }
}

async function sampleScrollFrames(page: Page, anchorSelector: string, frames: number) {
  return page.evaluate(async ([selector, frameCount]) => {
    let scroller: HTMLElement | null = document.querySelector<HTMLElement>(selector)
    while (scroller && !(scroller.scrollHeight > scroller.clientHeight + 10 && /auto|scroll/.test(getComputedStyle(scroller).overflowY))) {
      scroller = scroller.parentElement
    }
    const target = scroller ?? (document.scrollingElement as HTMLElement)
    target.scrollTop = 0
    await new Promise((resolve) => requestAnimationFrame(resolve))
    const step = Math.max(1, (target.scrollHeight - target.clientHeight) / frameCount)
    const intervals: number[] = []
    let previous = performance.now()
    for (let index = 0; index < frameCount; index += 1) {
      target.scrollTop += step
      await new Promise((resolve) => requestAnimationFrame(resolve))
      const now = performance.now()
      intervals.push(now - previous)
      previous = now
    }
    return intervals
  }, [anchorSelector, frames] as const)
}

// ---- Profile ---------------------------------------------------------------

test('profile notes editor', async ({ page }) => {
  test.setTimeout(300_000)
  const tiny = createNote('tiny', 'Tiny note', 3, 30)
  const large = createNote('large', 'Large note', LARGE_BLOCKS, 20)
  const mediumA = createNote('meda', 'Medium note A', MEDIUM_BLOCKS, 10)
  const mediumB = createNote('medb', 'Medium note B', MEDIUM_BLOCKS, 11)

  await boot(page, [tiny.note, large.note, mediumA.note, mediumB.note])
  const session = await page.context().newCDPSession(page)
  await session.send('Performance.enable')
  await openNote(page, 'Tiny note', blockSelector(tiny.lastId))
  await session.send('Emulation.setCPUThrottlingRate', { rate: CPU_RATE })
  const baselineMemory = await heapAndNodes(session)

  // Cold open of the large note, then warm reopen after visiting another note.
  const largeOpen = await taskTime(session, () => openNote(page, 'Large note', blockSelector(large.lastId)))
  const largeMemory = await heapAndNodes(session)
  await openNote(page, 'Tiny note', blockSelector(tiny.lastId))
  const largeReopenMs = await openNote(page, 'Large note', blockSelector(large.lastId))

  // Scrolling the large note top to bottom, one programmatic step per frame.
  const scrollIntervals = await sampleScrollFrames(page, blockSelector(large.firstId), 90)

  // Typing into a paragraph in the middle of the large note.
  await installKeyLatencyProbe(page)
  await placeCaretAtEnd(page, large.middleLeafId)
  await takeKeySamples(page)
  const typing = await taskTime(session, async () => {
    await page.keyboard.type(TYPED_TEXT, { delay: 45 })
    await page.waitForTimeout(400)
  })
  const typingSamples = (await takeKeySamples(page)).map((sample) => sample.ms)

  // Idle while focused: anything the editor does with nobody typing.
  const idle = await taskTime(session, () => page.waitForTimeout(2_000))

  // Splitting blocks with Enter, then merging them back with Backspace.
  await placeCaretAtEnd(page, large.middleLeafId)
  await takeKeySamples(page)
  const splitting = await taskTime(session, async () => {
    for (let index = 0; index < SPLIT_COUNT; index += 1) {
      await page.keyboard.press('Enter')
      await page.waitForTimeout(90)
    }
  })
  const enterSamples = (await takeKeySamples(page)).map((sample) => sample.ms)
  const merging = await taskTime(session, async () => {
    for (let index = 0; index < SPLIT_COUNT; index += 1) {
      await page.keyboard.press('Backspace')
      await page.waitForTimeout(90)
    }
  })
  const backspaceSamples = (await takeKeySamples(page)).map((sample) => sample.ms)

  // Pasting a block-heavy HTML fragment into the large note.
  await placeCaretAtEnd(page, large.middleLeafId)
  const pasteHtml = Array.from({ length: PASTE_BLOCKS }, (_, index) =>
    index % 5 === 0 ? `<h2>Pasted heading ${index}</h2>` : `<p>Pasted paragraph ${index} with <b>bold</b> text.</p>`).join('')
  const paste = await taskTime(session, () => page.evaluate(async ([html, selector, expectedIncrease]) => {
    const before = document.querySelectorAll(selector).length
    const target = document.activeElement as HTMLElement
    const clipboardData = new DataTransfer()
    clipboardData.setData('text/html', html)
    clipboardData.setData('text/plain', html.replace(/<[^>]+>/g, '\n'))
    const started = performance.now()
    target.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }))
    return new Promise<number | null>((resolve) => {
      const tick = () => {
        if (document.querySelectorAll(selector).length - before >= expectedIncrease) {
          requestAnimationFrame(() => setTimeout(() => resolve(performance.now() - started), 0))
        } else if (performance.now() - started > 15_000) resolve(null)
        else requestAnimationFrame(tick)
      }
      tick()
    })
  }, [pasteHtml, blockSelector(), Math.floor(PASTE_BLOCKS * 0.9)] as const))

  // Switching back and forth between two medium notes.
  const switchSamples: number[] = []
  for (let round = 0; round < SWITCH_ROUNDS; round += 1) {
    switchSamples.push(await openNote(page, 'Medium note A', blockSelector(mediumA.lastId)))
    switchSamples.push(await openNote(page, 'Medium note B', blockSelector(mediumB.lastId)))
  }

  const round = (value: number) => Math.round(value * 10) / 10
  const profile = {
    editor: EDITOR,
    fixture: { cpuRate: CPU_RATE, largeBlocks: LARGE_BLOCKS, mediumBlocks: MEDIUM_BLOCKS, typedChars: TYPED_TEXT.length },
    openLarge: { ms: round(largeOpen.result), taskMs: largeOpen.taskMs, reopenMs: round(largeReopenMs) },
    switchMedium: summarize(switchSamples),
    memory: {
      largeHeapMb: round(largeMemory.jsHeapMb - baselineMemory.jsHeapMb),
      largeDomNodes: largeMemory.domNodes - baselineMemory.domNodes,
    },
    scroll: { ...summarize(scrollIntervals), framesOver32Ms: scrollIntervals.filter((ms) => ms > 32).length },
    typing: { ...summarize(typingSamples), taskMsPerKey: round(typing.taskMs / Math.max(1, typingSamples.length)) },
    enter: { ...summarize(enterSamples), taskMsPerKey: round(splitting.taskMs / SPLIT_COUNT) },
    backspace: { ...summarize(backspaceSamples), taskMsPerKey: round(merging.taskMs / SPLIT_COUNT) },
    paste: { ms: paste.result == null ? null : round(paste.result), taskMs: paste.taskMs },
    idleTaskMsPerSecond: round(idle.taskMs / 2),
  }
  console.log(`NOTES_EDITOR_PERF ${JSON.stringify(profile)}`)
})
