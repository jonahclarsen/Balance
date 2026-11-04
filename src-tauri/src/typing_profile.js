// Page half of the dev-versus-release profile. Only the `typing-profile` cargo
// feature injects this; every note it creates is generated here.
;(() => {
  if (window.top !== window || location.pathname.includes('situate')) return

  const TYPED = 'the quick brown fox jumps over the lazy dog while notes stay fast '
  const KEYS_PER_NOTE = 100
  const KEY_INTERVAL_MS = 130
  const ENTER_COUNT = 10
  const ENTER_INTERVAL_MS = 500
  const SWITCHES = 6
  const THEME = 'graphite'
  const SAVES_QUIET_MS = 3_000
  const SAVES_TIMEOUT_MS = 240_000
  const consoleErrors = []
  const originalError = console.error
  console.error = (...args) => {
    if (consoleErrors.length < 20) consoleErrors.push(args.map(String).join(' ').slice(0, 300))
    originalError(...args)
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const invoke = (command, args = {}) => window.__TAURI_INTERNALS__.invoke(command, args)

  async function until(label, read, timeoutMs = 120_000) {
    const started = performance.now()
    for (;;) {
      const value = await read()
      if (value) return value
      if (performance.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`)
      await sleep(25)
    }
  }

  // ---- Synthetic corpus ----------------------------------------------------

  function item(id, kind, html, children = [], done = false) {
    const text = html.replace(/<[^>]+>/g, '')
    return { id, kind, text, html, done, startMinutes: null, endMinutes: null, children }
  }

  function createNote(prefix, title, blockCount) {
    const items = []
    let middle = ''
    for (let n = 0; n < blockCount; n += 1) {
      const id = `${prefix}_${String(n).padStart(5, '0')}`
      if (n % 20 === 0) items.push(item(id, 'heading', `Section ${n / 20 + 1}`))
      else if (n % 20 < 6) items.push(item(id, 'bullet', `Bullet entry ${n} with a little text`))
      else if (n % 20 < 10) items.push(item(id, 'checklist', `Checklist entry ${n}`, [], n % 3 === 0))
      else {
        items.push(item(id, 'paragraph', `Paragraph ${n} with <strong>bold</strong>, <em>italic</em> and enough words to wrap across a typical editor width.`))
        if (!middle && n >= blockCount / 2) middle = id
      }
    }
    const stamp = new Date(Date.UTC(2026, 0, 1, 9)).toISOString()
    return { middle, note: { id: `${prefix}_note`, title, items, createdAt: stamp, updatedAt: stamp, deletedAt: null } }
  }

  const SMALL = createNote('small', 'Profile small', 30)
  const MEDIUM = createNote('medium', 'Profile medium', 150)
  const LARGE = createNote('large', 'Profile large', 1000)
  const corpus = () => [
    SMALL.note,
    MEDIUM.note,
    LARGE.note,
    ...Array.from({ length: 150 }, (_, index) => createNote(`bg${index}`, `Background ${index}`, 40).note),
  ]

  // ---- Notes page ----------------------------------------------------------

  const notesButton = () => document.querySelector('button[data-nav-view="notes"]')

  const blockSelector = (id) => `[data-note-editor="lexical"] [data-item-id="${id}"]`
  const frame = () => new Promise((resolve) => requestAnimationFrame(() => {
    const channel = new MessageChannel()
    channel.port1.onmessage = resolve
    channel.port2.postMessage(null)
  }))

  async function openNote(target) {
    const card = await until(`${target.note.title} card`, () => [...document.querySelectorAll('.note-card')]
      .find((candidate) => candidate.querySelector('strong')?.textContent?.trim() === target.note.title))
    const started = performance.now()
    card.click()
    await until(`${target.note.title} editor`, () => document.querySelector(blockSelector(target.note.items.at(-1).id)))
    await frame()
    return performance.now() - started
  }

  async function placeCaret(id) {
    const block = await until('caret block', () => document.querySelector(blockSelector(id)))
    block.scrollIntoView({ block: 'center' })
    const editable = block.querySelector('[contenteditable="true"]') ?? block.closest('[contenteditable="true"]')
    if (!editable) throw new Error('Block has no editable surface')
    editable.focus()
    const range = document.createRange()
    range.selectNodeContents(editable.contains(block) ? block : editable)
    range.collapse(false)
    const selection = document.getSelection()
    selection.removeAllRanges()
    selection.addRange(range)
    document.dispatchEvent(new Event('selectionchange'))
    await sleep(500)
  }

  // Wall-clock time so the native send and the page's frame share one clock.
  // scriptMs is the page's own work for the key, whatever the frame cadence.
  const keys = []
  let untrustedKeys = 0
  window.addEventListener('keydown', (event) => {
    if (!event.isTrusted) untrustedKeys += 1
    const key = { frame: null, script: null, started: performance.now() }
    keys.push(key)
    requestAnimationFrame(() => {
      const channel = new MessageChannel()
      channel.port1.onmessage = () => { key.frame = Date.now() }
      channel.port2.postMessage(null)
    })
  }, true)
  window.addEventListener('input', () => {
    const key = keys.at(-1)
    if (!key || key.script !== null) return
    const channel = new MessageChannel()
    channel.port1.onmessage = () => { key.script = performance.now() - key.started }
    channel.port2.postMessage(null)
  }, true)

  // Waits for the app to stop saving, so a backlog is measured rather than cut off.
  async function collectSaves() {
    const saves = []
    let lastChange = performance.now()
    const started = lastChange
    while (performance.now() - started < SAVES_TIMEOUT_MS) {
      const taken = await invoke('typing_profile_take_persists')
      if (taken.length) {
        saves.push(...taken)
        lastChange = performance.now()
      }
      if (saves.length && performance.now() - lastChange >= SAVES_QUIET_MS) break
      await sleep(100)
    }
    return saves
  }

  async function press(text, intervalMs) {
    keys.length = 0
    await invoke('typing_profile_take_persists')
    const sent = await invoke('typing_profile_type', { text, intervalMs })
    await until('key frames', () => keys.length >= sent.length && keys.every((key) => key.frame !== null), 120_000)
    const saves = await collectSaves()
    return {
      latencyMs: sent.map((at, index) => keys[index].frame - at),
      scriptMs: keys.map((key) => key.script).filter((value) => value !== null),
      persistMs: saves.map(([, ms]) => ms),
      saveLagMs: saves.length ? Math.max(...saves.map(([at]) => at)) - sent.at(-1) : null,
    }
  }

  // ---- Run -----------------------------------------------------------------

  async function run() {
    await until('Tauri', () => window.__TAURI_INTERNALS__?.invoke)
    const button = await until('Notes button', notesButton)
    const reloadMs = performance.now()

    const raw = await until('stored state', () => invoke('read_app_state', {}))
    if (!raw.includes('"Profile small"')) {
      // A fresh synthetic database: confirm its test-only key and add the notes.
      const status = await invoke('get_recovery_key_status')
      if (status?.recoveryKey) await invoke('confirm_recovery_key', { recoveryKey: status.recoveryKey })
      // The app prefers this device copy of its appearance and saves it back.
      localStorage.setItem('balance:deviceAppearance.v1', JSON.stringify({ version: 1, colorScheme: 'system', themeId: THEME }))
      await invoke('initialize_app_state', { stateJson: JSON.stringify({ ...JSON.parse(raw), notes: corpus() }) })
      location.reload()
      return
    }

    await sleep(5_000)
    // Only the release build checks for updates; its prompt must not differ.
    ;[...document.querySelectorAll('button')].find((candidate) => candidate.textContent?.trim() === 'Not now')?.click()
    button.click()
    await until('note cards', () => document.querySelector('.note-card'))

    const switchMs = { medium: [], large: [] }
    for (let round = 0; round < SWITCHES; round += 1) {
      switchMs.medium.push(await openNote(MEDIUM))
      await sleep(250)
      switchMs.large.push(await openNote(LARGE))
      await sleep(250)
    }

    const text = TYPED.repeat(Math.ceil(KEYS_PER_NOTE / TYPED.length)).slice(0, KEYS_PER_NOTE)
    const typing = {}
    for (const [name, target] of [['small', SMALL], ['medium', MEDIUM], ['large', LARGE]]) {
      await openNote(target)
      await placeCaret(target.middle)
      typing[name] = await press(text, KEY_INTERVAL_MS)
    }
    const enter = await press('\r'.repeat(ENTER_COUNT), ENTER_INTERVAL_MS)

    const saved = await until('saved text', async () => {
      const state = await invoke('read_app_state', {})
      return state?.split(text.slice(0, 40)).length >= 4 ? state : null
    }, 30_000)

    return {
      reloadMs,
      switchMs,
      typing,
      enter,
      hasFocus: document.hasFocus(),
      untrustedKeys,
      savedBytes: saved.length,
      theme: document.documentElement.dataset.theme,
      consoleErrors,
    }
  }

  async function main() {
    let report
    try {
      report = await run()
      if (!report) return
    } catch (error) {
      report = { error: String(error?.message ?? error), consoleErrors }
    }
    await invoke('typing_profile_finish', { report: JSON.stringify(report) })
  }

  void main()
})()
