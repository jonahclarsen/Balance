/** Device-local rules. No planner records, notification contents, or telemetry. */
export type Platform = 'mac' | 'android' | 'windows'
export type Category = 'social' | 'entertainment' | 'ai' | 'custom'
/** minutes caps the pass when this question is asked. */
export type Question = { id: string; text: string; required: boolean | null; when?: { id: string; answer: boolean }; minutes?: number }
export type Target = { id: string; category: Category; kind: 'domain' | 'app' | 'discord'; value: string }
export type Mode = {
  id: string; name: string; description: string; color: string; platforms: Platform[]; scheduled: boolean
  dayQuiz: Question[]; nightQuiz: Question[]; targets: Target[]
  /** A scheduled mode that turns on only at evening, not at morning. */
  eveningOnly?: boolean
  /** Notify this many minutes before the mode turns back on. */
  headsUp?: number[]
  /** A reminder mode blocks nothing and has no quiz: it is on daily between these clock minutes. */
  reminder?: { from: number; until: number }
}
export type Settings = {
  wakeMinutes: number; eveningMinutes: number; sunsetOffset: number; lateOffset: number
  lateMinutes: number
  nightMinutes: number; lateNightMinutes: number; accessMinutes: number
}
export type Epoch = { at: number; end: number; phase: 'day' | 'night'; late: number }
export type Window = { mode: string; at: number; end: number }
/** target is '' for the whole mode or an entertainment target's ID for access to that one site. */
export type Grant = { mode: string; target: string; epoch: number; until: number }
export type Document = {
  version: 1; revision: number; settings: Settings; modes: Mode[]; epochs: Epoch[]; windows: Window[]
  manual: Record<string, number>; grants: Grant[]; generatedAt: number
  /** One quiz for an entertainment site, passing every mode that blocks it. */
  accessQuiz: Question[]
  /** Preset revision, so new default targets reach existing rules once. */
  presets?: number
}
export type Answers = Record<string, boolean>
const minute = 60_000
const q = (id: string, text: string, required: boolean | null = true): Question => ({ id, text, required })
const entertainment: Question[] = [q('visual', 'Is this visual entertainment?', null), {
  ...q('care', 'Are you eating a meal, doing the dishes, taking a bath, or brushing your teeth?'), when: { id: 'visual', answer: true },
}]
export const MODE_COLORS = ['#d9643a', '#3f9d54', '#5865f2', '#c2418a', '#c9961c', '#2f8fb0', '#8a5cc7', '#6b7b85']
const PRESET_COLORS: Record<string, string> = { dolo: MODE_COLORS[0], 'touch-grass': MODE_COLORS[1], discord: MODE_COLORS[2] }
export const CATEGORIES: { id: Category; label: string; color: string }[] = [
  { id: 'social', label: 'Social', color: '#d0458b' },
  { id: 'entertainment', label: 'Entertainment', color: '#d08a12' },
  { id: 'ai', label: 'AI', color: '#7b5cd6' },
  { id: 'custom', label: 'Other', color: '#5f7d8c' },
]
const target = (category: Category, kind: Target['kind'], value: string): Target => ({ id: `${kind}:${value}`, category, kind, value })
const PRESETS = 10
const emergency: Question = { ...q('emergency', 'Is this an emergency?'), when: { id: 'planned', answer: false }, minutes: 5 }
// Google Messages, WhatsApp, Messenger, Instagram, the Feurstagram clone and Signal on Android and Mac.
const messagingApps = ['com.google.android.apps.messaging', 'com.whatsapp', 'net.whatsapp.WhatsApp', 'com.facebook.orca', 'com.facebook.archon', 'com.facebook.archon.developerID', 'com.burbn.instagram', 'com.instagram.android.feurstagram', 'org.thoughtcrime.securesms', 'org.whispersystems.signal-desktop']
  .map(v => target('social', 'app', v))
const reminder = (id: string, name: string, description: string, color: string, from: number, until: number): Mode =>
  ({ id, name, description, color, platforms: ['mac', 'android'], scheduled: false, dayQuiz: [], nightQuiz: [], targets: [], reminder: { from, until } })
export function defaults(now = Date.now()): Document {
  const targets: Target[] = [
    ...['instagram.com', 'facebook.com', 'tiktok.com', 'reddit.com', 'x.com', 'twitter.com', 'threads.net', 'bsky.app', 'snapchat.com'].map(v => target('social', 'domain', v)),
    ...['com.instagram.android', 'com.facebook.katana', 'com.zhiliaoapp.musically', 'com.reddit.frontpage', 'com.twitter.android', 'com.snapchat.android', 'xyz.blueskyweb.app'].map(v => target('social', 'app', v)),
    ...messagingApps,
    ...['youtube.com', 'youtu.be', 'netflix.com', 'twitch.tv', 'disneyplus.com'].map(v => target('entertainment', 'domain', v)),
    ...['org.videolan.vlc', 'com.google.android.youtube', 'com.netflix.mediaclient'].map(v => target('entertainment', 'app', v)),
    ...['chatgpt.com', 'chat.openai.com', 'claude.ai', 'gemini.google.com', 'perplexity.ai', 'copilot.microsoft.com', 'grok.com'].map(v => target('ai', 'domain', v)),
    ...['com.openai.codex', 'com.openai.chat', 'com.openai.chatgpt', 'com.anthropic.claudefordesktop', 'com.anthropic.claude', 'com.google.android.apps.bard'].map(v => target('ai', 'app', v)),
  ]
  const thrust = [q('thrust', 'Did you do one thrust? Get up and thrust your chosen object in and out of your bag.')]
  const doc: Document = {
    version: 1, revision: 0, presets: PRESETS, generatedAt: now, manual: {}, grants: [], epochs: [], windows: [], accessQuiz: entertainment,
    settings: { wakeMinutes: 420, eveningMinutes: 1290, sunsetOffset: 240, lateOffset: 480, lateMinutes: 150, nightMinutes: 60, lateNightMinutes: 30, accessMinutes: 15 },
    modes: [
      { id: 'dolo', name: 'Dolo', description: 'Social and messaging apps, plus entertainment.', color: PRESET_COLORS.dolo, platforms: ['mac', 'android'], scheduled: true, dayQuiz: thrust, nightQuiz: thrust, targets: targets.filter(t => t.category !== 'ai') },
      { id: 'touch-grass', name: 'Touch grass', description: 'AI chats and entertainment.', color: PRESET_COLORS['touch-grass'], platforms: ['mac', 'android'], scheduled: true, eveningOnly: true, headsUp: [15, 5], dayQuiz: [q('planned', 'Have you planned tomorrow?'), emergency], nightQuiz: [q('peed', 'Have you just peed?'), q('bed', 'Have you spent one minute in bed with the lights off and Herdr muted?')], targets: targets.filter(t => t.category !== 'social') },
      reminder('active-projects', 'Active Projects', 'Time for your active projects.', MODE_COLORS[5], 420, 1200),
      reminder('no-active-project', 'No Active Project', 'Leave projects for tomorrow.', MODE_COLORS[6], 1260, 420),
      { id: 'discord', name: 'Discord', description: 'Discord on your phone.', color: PRESET_COLORS.discord, platforms: ['android'], scheduled: false, dayQuiz: [q('intentional', 'Do you have a specific reason to open Discord now?')], nightQuiz: [q('intentional', 'Do you have a specific reason to open Discord now?')], targets: [target('custom', 'app', 'com.discord'), target('custom', 'domain', 'discord.com')] },
    ],
  }
  return regenerate(doc, now)
}
type Legacy = { categories?: unknown; enabled?: unknown; latitude?: unknown; longitude?: unknown; accessQuiz?: Question[] }
export function upgradePresets(doc: Document): Document {
  const version = doc.presets ?? 1
  if (version >= PRESETS) return doc
  // v2 added messaging apps to Dolo and v3 mode colors. v3 briefly dropped entertainment
  // access, which v4 restores, and the global switch gave way to per-mode control. v5 takes
  // the sunset location from the time zone instead of entered coordinates; v6 adds descriptions
  // and v7 the reminder modes. v8 lets an emergency excuse Touch grass's planning question;
  // v9 turns Touch grass on only at evening, with 15- and 5-minute heads-ups; v10 replaces
  // each mode's entertainment quiz with one shared quiz, keeping Dolo's.
  const preset = defaults(doc.generatedAt).modes
  const legacy = doc.modes as (Mode & Legacy)[]
  const accessQuiz = doc.accessQuiz ?? [legacy.find(m => m.id === 'dolo'), ...legacy].find(m => m?.accessQuiz?.length)?.accessQuiz ?? entertainment
  const modes = doc.modes.map((m: Partial<Mode> & Mode & Legacy, i) => {
    const { categories: _categories, accessQuiz: _accessQuiz, ...mode } = m
    const targets = version < 2 && m.id === 'dolo' ? [...m.targets, ...messagingApps.filter(t => !m.targets.some(x => x.id === t.id))] : m.targets
    const fallback = preset.find(p => p.id === m.id)
    const dayQuiz = version < 8 && m.id === 'touch-grass' && m.dayQuiz.some(q => q.id === 'planned') && !m.dayQuiz.some(q => q.id === emergency.id) ? [...m.dayQuiz, emergency] : m.dayQuiz
    const evening = version < 9 && m.id === 'touch-grass' && m.scheduled ? { eveningOnly: true, headsUp: m.headsUp ?? [15, 5] } : {}
    return { ...mode, ...evening, dayQuiz, color: m.color ?? PRESET_COLORS[m.id] ?? MODE_COLORS[i % MODE_COLORS.length], description: m.description ?? fallback?.description ?? '', targets }
  })
  const { enabled: _enabled, ...rest } = doc as Document & Legacy
  const { latitude: _latitude, longitude: _longitude, ...kept } = doc.settings as Settings & Legacy
  const settings = { ...kept, accessMinutes: kept.accessMinutes ?? 15 }
  const grants = doc.grants.map(g => ({ ...g, target: g.target ?? '' }))
  const reminders = version < 7 ? preset.filter(p => p.reminder && !modes.some(m => m.id === p.id)) : []
  return { ...rest, presets: PRESETS, accessQuiz, settings, modes: [...modes, ...reminders], grants, windows: doc.windows ?? [] }
}
// NOAA solar geometry. Calculate locally; coordinates never leave this device.
export function sunset(date: Date, latitude: number, longitude: number): number | null {
  const rad = Math.PI / 180
  const noon = new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime()
  const days = (noon - Date.UTC(2000, 0, 1, 12)) / 86_400_000
  const n = Math.round(days - 0.0009 + longitude / 360)
  const j = 0.0009 - longitude / 360 + n
  const m = (357.5291 + 0.98560028 * j) * rad
  const c = 1.9148 * Math.sin(m) + 0.02 * Math.sin(2 * m) + 0.0003 * Math.sin(3 * m)
  const l = (m / rad + c + 180 + 102.9372) * rad
  const transit = 2451545 + j + 0.0053 * Math.sin(m) - 0.0069 * Math.sin(2 * l)
  const dec = Math.asin(Math.sin(l) * Math.sin(23.44 * rad))
  const cosine = (Math.sin(-0.833 * rad) - Math.sin(latitude * rad) * Math.sin(dec)) / (Math.cos(latitude * rad) * Math.cos(dec))
  if (cosine < -1 || cosine > 1) return null
  return (transit + Math.acos(cosine) / (2 * Math.PI) - 2440587.5) * 86_400_000
}
function clock(day: Date, minutes: number): number {
  return new Date(day.getFullYear(), day.getMonth(), day.getDate(), 0, minutes).getTime()
}
export type Location = { name: string; zone: string; latitude: number; longitude: number }
// The largest Canadian city in each Canadian time zone.
const CITIES: Location[] = [
  { name: 'Vancouver', zone: 'America/Vancouver', latitude: 49.28, longitude: -123.12 },
  { name: 'Whitehorse', zone: 'America/Whitehorse', latitude: 60.72, longitude: -135.06 },
  { name: 'Calgary', zone: 'America/Edmonton', latitude: 51.05, longitude: -114.07 },
  { name: 'Saskatoon', zone: 'America/Regina', latitude: 52.13, longitude: -106.67 },
  { name: 'Winnipeg', zone: 'America/Winnipeg', latitude: 49.9, longitude: -97.14 },
  { name: 'Toronto', zone: 'America/Toronto', latitude: 43.65, longitude: -79.38 },
  { name: 'Halifax', zone: 'America/Halifax', latitude: 44.65, longitude: -63.57 },
  { name: "St. John's", zone: 'America/St_Johns', latitude: 47.56, longitude: -52.71 },
]
function utcOffset(zone: string, at: number): number | null {
  try {
    const name = new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' }).formatToParts(at).find(p => p.type === 'timeZoneName')?.value ?? ''
    const m = /^GMT(?:([+-])(\d{2}):(\d{2}))?$/.exec(name)
    return m ? (m[1] === '-' ? -1 : 1) * (Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)) : null
  } catch { return null }
}
/** Sunset comes from the largest Canadian city sharing this time zone's offsets, or none outside them. */
export function timeZoneLocation(zone = Intl.DateTimeFormat().resolvedOptions().timeZone, year = new Date().getFullYear()): Location | null {
  const exact = CITIES.find(c => c.zone === zone)
  if (exact) return exact
  const offsets = (z: string) => [utcOffset(z, Date.UTC(year, 0, 15)), utcOffset(z, Date.UTC(year, 6, 15))]
  const [winter, summer] = offsets(zone)
  if (winter === null) return null
  const matches = CITIES.filter(c => offsets(c.zone)[0] === winter)
  return matches.find(c => offsets(c.zone)[1] === summer) ?? matches[0] ?? null
}
export function regenerate(doc: Document, now = Date.now(), location = timeZoneLocation()): Document {
  const { settings: s } = doc
  const epochs: Epoch[] = []
  // Dates, rather than 24-hour additions, preserve local wall clocks across DST.
  for (let i = -2; i < 400; i++) {
    const day = new Date(now); day.setDate(day.getDate() + i)
    const wake = clock(day, s.wakeMinutes)
    const nextDay = new Date(day); nextDay.setDate(nextDay.getDate() + 1)
    const end = clock(nextDay, s.wakeMinutes)
    const sun = location ? sunset(day, location.latitude, location.longitude) : null
    const evening = Math.min(end - minute, Math.max(wake + minute, clock(day, s.eveningMinutes), sun === null ? 0 : sun + s.sunsetOffset * minute))
    // Late clock belongs to the night following this day's sunset.
    const lateDay = s.lateMinutes < s.eveningMinutes ? nextDay : day
    const rawLate = sun === null ? clock(lateDay, s.lateMinutes) : sun + s.lateOffset * minute
    const localLate = new Date(rawLate)
    localLate.setMinutes(Math.round(localLate.getMinutes() / 30) * 30, 0, 0)
    const late = Math.max(evening, Math.min(end, localLate.getTime()))
    epochs.push({ at: wake, end: evening, phase: 'day', late }, { at: evening, end, phase: 'night', late })
  }
  const windows: Window[] = []
  for (const mode of doc.modes) {
    if (!mode.reminder) continue
    const { from, until } = mode.reminder
    for (let i = -2; i < 400; i++) {
      const day = new Date(now); day.setDate(day.getDate() + i)
      const endDay = new Date(day); if (until <= from) endDay.setDate(endDay.getDate() + 1)
      windows.push({ mode: mode.id, at: clock(day, from), end: clock(endDay, until) })
    }
  }
  return { ...doc, generatedAt: now, epochs, windows, grants: doc.grants.filter(g => g.until > now) }
}
export function epoch(doc: Document, now: number): Epoch | undefined { return doc.epochs.find(e => e.at <= now && now < e.end) }
export function isActive(doc: Document, mode: Mode, platform: Platform, now = Date.now(), targetId = ''): boolean {
  if (!mode.platforms.includes(platform)) return false
  if (mode.reminder) return doc.windows.some(w => w.mode === mode.id && w.at <= now && now < w.end)
  const activation = activatedAt(doc, mode, now)
  if (!activation) return false
  return !doc.grants.some(g => g.mode === mode.id && (g.target === '' || g.target === targetId) && g.epoch >= activation && g.until > now)
}
const eveningOnly = (mode: Mode) => mode.scheduled && !!mode.eveningOnly
function activatedAt(doc: Document, mode: Mode, now: number): number {
  const e = epoch(doc, now)
  const at = e?.at ?? doc.generatedAt
  const scheduled = mode.scheduled && !(eveningOnly(mode) && e?.phase !== 'night')
  // An evening-only mode turned on by hand stays on only until the next morning.
  const manual = doc.manual[mode.id] ?? 0
  return Math.max(scheduled ? at : 0, eveningOnly(mode) && manual < at ? 0 : manual)
}

/** The day (wake to evening) that the current moment belongs to, plus the next wake. */
export function scheduleToday(doc: Document, now: number): { wake: number; evening: number; late: number; nextWake: number } | undefined {
  const i = doc.epochs.findIndex(e => e.at <= now && now < e.end)
  const day = doc.epochs[doc.epochs[i]?.phase === 'night' ? i - 1 : i]
  const night = doc.epochs[doc.epochs.indexOf(day!) + 1]
  return day && night && { wake: day.at, evening: day.end, late: day.late, nextWake: night.end }
}
/** When an off mode comes back on, or null if it stays off until turned on. */
export function backOn(doc: Document, mode: Mode, now: number): number | null {
  if (mode.reminder) return null
  const end = epoch(doc, now)?.end ?? Infinity
  const pass = doc.grants.find(g => g.mode === mode.id && !g.target && g.epoch >= activatedAt(doc, mode, now) && g.until > now)
  if (pass && pass.until < Number.MAX_SAFE_INTEGER && (pass.until < end || !mode.scheduled)) return pass.until
  return nextScheduled(doc, mode, now)
}
/** When the schedule next turns a mode on, after now. */
export function nextScheduled(doc: Document, mode: Mode, now: number): number | null {
  if (!mode.scheduled) return null
  return doc.epochs.find(e => e.at > now && (!eveningOnly(mode) || e.phase === 'night'))?.at ?? null
}
/** The heads-up, in minutes, whose time before an off mode comes back on has been reached. */
export function headsUp(doc: Document, mode: Mode, platform: Platform, now: number): number | null {
  if (!mode.headsUp?.length || isActive(doc, mode, platform, now)) return null
  const on = backOn(doc, mode, now)
  const reached = on === null ? [] : mode.headsUp.filter(m => now >= on - m * minute)
  return reached.length ? Math.min(...reached) : null
}
export function questions(doc: Document, mode: Mode, now: number, targetId = ''): Question[] {
  if (targetId) {
    const t = mode.targets.find(t => t.id === targetId)
    if (!t || t.category !== 'entertainment') throw new Error('This target requires the mode quiz.')
    return doc.accessQuiz
  }
  return epoch(doc, now)?.phase === 'night' ? mode.nightQuiz : mode.dayQuiz
}
const asked = (question: Question, answers: Answers) => !question.when || answers[question.when.id] === question.when.answer
export function quizProgress(quiz: Question[], answers: Answers): { next?: Question; denied: boolean } {
  for (const [i, question] of quiz.entries()) {
    if (!asked(question, answers)) continue
    if (typeof answers[question.id] !== 'boolean') return { next: question, denied: false }
    // A later question asked on this answer decides instead.
    const followUp = quiz.slice(i + 1).some(q => q.when?.id === question.id && q.when.answer === answers[question.id])
    if (question.required !== null && answers[question.id] !== question.required && !followUp) return { denied: true }
  }
  return { denied: false }
}
export function grant(doc: Document, modeId: string, answers: Answers, startedAt: number, now = Date.now(), targetId = ''): Document {
  const mode = doc.modes.find(m => m.id === modeId)
  const e = epoch(doc, now)
  if (!mode || !e || epoch(doc, startedAt)?.at !== e.at || startedAt < (doc.manual[modeId] ?? 0)) throw new Error('The rules changed. Please start the quiz again.')
  const quiz = questions(doc, mode, now, targetId)
  const progress = quizProgress(quiz, answers)
  if (progress.denied || progress.next) throw new Error('Complete the quiz before continuing.')
  const s = doc.settings
  const limit = Math.min(...quiz.filter(q => asked(q, answers)).map(q => q.minutes ?? Infinity))
  const minutes = Math.min(limit, targetId ? s.accessMinutes : mode.id === 'touch-grass' && e.phase === 'night' ? now >= e.late ? s.lateNightMinutes : s.nightMinutes : Infinity)
  const until = !mode.scheduled && !targetId && minutes === Infinity ? Number.MAX_SAFE_INTEGER : Math.min(e.end, now + minutes * minute)
  // An entertainment pass covers the site in every mode that blocks it.
  const passed = targetId ? doc.modes.filter(m => m.targets.some(t => t.id === targetId && t.category === 'entertainment') && startedAt >= (doc.manual[m.id] ?? 0)).map(m => m.id) : [modeId]
  const entries: Grant[] = passed.map(id => ({ mode: id, target: targetId, epoch: Math.max(e.at, doc.manual[id] ?? 0), until }))
  return { ...doc, revision: doc.revision + 1, grants: [...doc.grants.filter(g => !(passed.includes(g.mode) && g.target === targetId)), ...entries] }
}
export function enableMode(doc: Document, mode: string, now = Date.now()): Document {
  const found = doc.modes.find(m => m.id === mode)
  if (!found) throw new Error('Unknown mode')
  if (found.reminder) throw new Error('Reminder modes follow their hours')
  return { ...doc, revision: doc.revision + 1, manual: { ...doc.manual, [mode]: now }, grants: doc.grants.filter(g => g.mode !== mode) }
}
export function matches(target: Target, kind: Target['kind'], value: string): boolean {
  if (kind !== target.kind) return false
  if (kind !== 'domain') return target.value === value
  const host = value.toLowerCase().replace(/\.$/, '')
  const domain = target.value.toLowerCase().replace(/\.$/, '')
  return host === domain || host.endsWith(`.${domain}`)
}
export function validate(doc: Document): void {
  if (doc.version !== 1 || !Array.isArray(doc.modes) || doc.modes.length > 30 || !Array.isArray(doc.accessQuiz)) throw new Error('Unsupported Situate rules')
  validateQuiz(doc.accessQuiz)
  const s = doc.settings
  for (const k of ['wakeMinutes', 'eveningMinutes', 'lateMinutes'] as const) if (!Number.isInteger(s[k]) || s[k] < 0 || s[k] >= 1440) throw new Error('Choose a valid clock time')
  for (const k of ['nightMinutes', 'lateNightMinutes', 'accessMinutes'] as const) if (!Number.isFinite(s[k]) || s[k] < 1 || s[k] > 240) throw new Error('Allow between 1 and 240 minutes')
  for (const k of ['sunsetOffset', 'lateOffset'] as const) if (!Number.isFinite(s[k]) || s[k] < 0 || s[k] > 1440) throw new Error('Sunset offsets must be between 0 and 24 hours')
  const ids = new Set<string>()
  for (const m of doc.modes) {
    if (!/^[a-z0-9-]{1,64}$/.test(m.id) || ids.has(m.id) || !m.name.trim() || m.name.length > 100) throw new Error('Modes need unique IDs and a name')
    ids.add(m.id)
    if (!/^#[0-9a-f]{6}$/i.test(m.color)) throw new Error('Choose a mode color')
    if (typeof m.description !== 'string' || m.description.length > 300) throw new Error('Keep descriptions under 300 characters')
    if (!m.platforms.length || m.platforms.some(p => !['mac', 'android', 'windows'].includes(p))) throw new Error('Choose at least one device')
    validateQuiz(m.dayQuiz); validateQuiz(m.nightQuiz)
    if (m.headsUp && (m.headsUp.length > 5 || m.headsUp.some(t => !Number.isInteger(t) || t < 1 || t > 240))) throw new Error('Heads-ups must be between 1 and 240 minutes')
    if (m.reminder && (![m.reminder.from, m.reminder.until].every(t => Number.isInteger(t) && t >= 0 && t < 1440) || m.reminder.from === m.reminder.until || m.targets.length)) throw new Error('Reminder modes need different start and end times')
    if (m.targets.length > 300) throw new Error('Use at most 300 targets per mode')
    for (const t of m.targets) {
      if (!t.value || t.value.length > 255 || /[\s/\\]/.test(t.value) || !['domain', 'app', 'discord'].includes(t.kind)) throw new Error('Targets use a domain, bundle/package ID, or Discord channel ID')
    }
  }
}
function validateQuiz(quiz: Question[]): void {
  const seen = new Set<string>()
  if (quiz.length > 50) throw new Error('Use at most 50 questions')
  for (const q of quiz) {
    if (!q.id || seen.has(q.id) || !q.text.trim() || q.text.length > 2000 || ![true, false, null].includes(q.required) || (q.when && !seen.has(q.when.id))) throw new Error('Conditions must refer to an earlier question')
    if (q.minutes !== undefined && !(Number.isFinite(q.minutes) && q.minutes >= 1 && q.minutes <= 240)) throw new Error('Allow between 1 and 240 minutes')
    seen.add(q.id)
  }
}
