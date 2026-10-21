/** Device-local rules. No planner records, notification contents, or telemetry. */
export type Platform = 'mac' | 'android' | 'windows'
export type Category = 'social' | 'entertainment' | 'ai' | 'custom'
export type Question = { id: string; text: string; required: boolean | null; when?: { id: string; answer: boolean } }
export type Target = { id: string; category: Category; kind: 'domain' | 'app' | 'discord'; value: string }
export type Mode = {
  id: string; name: string; platforms: Platform[]; categories: Category[]; scheduled: boolean
  dayQuiz: Question[]; nightQuiz: Question[]; accessQuiz: Question[]; targets: Target[]
}
export type Settings = {
  wakeMinutes: number; eveningMinutes: number; sunsetOffset: number; lateOffset: number
  lateMinutes: number; latitude: number | null; longitude: number | null
  nightMinutes: number; lateNightMinutes: number; accessMinutes: number
}
export type Epoch = { at: number; end: number; phase: 'day' | 'night'; late: number }
export type Grant = { mode: string; target: string; epoch: number; until: number }
export type Document = {
  version: 1; revision: number; settings: Settings; modes: Mode[]; epochs: Epoch[]
  enabled: boolean; manual: Record<string, number>; grants: Grant[]; generatedAt: number
  /** Preset revision, so new default targets reach existing rules once. */
  presets?: number
}
export type Answers = Record<string, boolean>
const minute = 60_000
const q = (id: string, text: string, required: boolean | null = true): Question => ({ id, text, required })
const entertainment: Question[] = [q('visual', 'Is this visual entertainment?', null), {
  ...q('care', 'Are you eating a meal, doing the dishes, taking a bath, or brushing your teeth?'), when: { id: 'visual', answer: true },
}]
const target = (category: Category, kind: Target['kind'], value: string): Target => ({ id: `${kind}:${value}`, category, kind, value })
const PRESETS = 2
// Google Messages, WhatsApp, Messenger, Instagram, the Feurstagram clone and Signal on Android and Mac.
const messagingApps = ['com.google.android.apps.messaging', 'com.whatsapp', 'net.whatsapp.WhatsApp', 'com.facebook.orca', 'com.facebook.archon', 'com.facebook.archon.developerID', 'com.burbn.instagram', 'com.instagram.android.feurstagram', 'org.thoughtcrime.securesms', 'org.whispersystems.signal-desktop']
  .map(v => target('social', 'app', v))
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
    version: 1, revision: 0, presets: PRESETS, enabled: false, generatedAt: now, manual: {}, grants: [], epochs: [],
    settings: { wakeMinutes: 420, eveningMinutes: 1290, sunsetOffset: 240, lateOffset: 480, lateMinutes: 150, latitude: null, longitude: null, nightMinutes: 60, lateNightMinutes: 30, accessMinutes: 15 },
    modes: [
      { id: 'dolo', name: 'Dolo', platforms: ['mac', 'android'], categories: ['social', 'entertainment'], scheduled: true, dayQuiz: thrust, nightQuiz: thrust, accessQuiz: entertainment, targets: targets.filter(t => t.category !== 'ai') },
      { id: 'touch-grass', name: 'Touch grass', platforms: ['mac', 'android'], categories: ['ai', 'entertainment'], scheduled: true, dayQuiz: [q('planned', 'Have you planned tomorrow?')], nightQuiz: [q('peed', 'Have you just peed?'), q('bed', 'Have you spent one minute in bed with the lights off and Herdr muted?')], accessQuiz: entertainment, targets: targets.filter(t => t.category !== 'social') },
      { id: 'discord', name: 'Discord', platforms: ['android'], categories: ['custom'], scheduled: false, dayQuiz: [q('intentional', 'Do you have a specific reason to open Discord now?')], nightQuiz: [q('intentional', 'Do you have a specific reason to open Discord now?')], accessQuiz: [], targets: [target('custom', 'app', 'com.discord'), target('custom', 'domain', 'discord.com')] },
    ],
  }
  return regenerate(doc, now)
}
export function upgradePresets(doc: Document): Document {
  if ((doc.presets ?? 1) >= PRESETS) return doc
  const modes = doc.modes.map(m => m.id !== 'dolo' ? m : { ...m, targets: [...m.targets, ...messagingApps.filter(t => !m.targets.some(x => x.id === t.id))] })
  return { ...doc, presets: PRESETS, modes }
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
export function regenerate(doc: Document, now = Date.now()): Document {
  const { settings: s } = doc
  const epochs: Epoch[] = []
  // Dates, rather than 24-hour additions, preserve local wall clocks across DST.
  for (let i = -2; i < 400; i++) {
    const day = new Date(now); day.setDate(day.getDate() + i)
    const wake = clock(day, s.wakeMinutes)
    const nextDay = new Date(day); nextDay.setDate(nextDay.getDate() + 1)
    const end = clock(nextDay, s.wakeMinutes)
    const sun = s.latitude !== null && s.longitude !== null ? sunset(day, s.latitude, s.longitude) : null
    const evening = Math.min(end - minute, Math.max(wake + minute, clock(day, s.eveningMinutes), sun === null ? 0 : sun + s.sunsetOffset * minute))
    // Late clock belongs to the night following this day's sunset.
    const lateDay = s.lateMinutes < s.eveningMinutes ? nextDay : day
    const rawLate = sun === null ? clock(lateDay, s.lateMinutes) : sun + s.lateOffset * minute
    const localLate = new Date(rawLate)
    localLate.setMinutes(Math.round(localLate.getMinutes() / 30) * 30, 0, 0)
    const late = Math.max(evening, Math.min(end, localLate.getTime()))
    epochs.push({ at: wake, end: evening, phase: 'day', late }, { at: evening, end, phase: 'night', late })
  }
  return { ...doc, generatedAt: now, epochs, grants: doc.grants.filter(g => g.until > now) }
}
export function epoch(doc: Document, now: number): Epoch | undefined { return doc.epochs.find(e => e.at <= now && now < e.end) }
export function isActive(doc: Document, mode: Mode, platform: Platform, now = Date.now(), targetId = ''): boolean {
  if (!doc.enabled || !mode.platforms.includes(platform)) return false
  const e = epoch(doc, now)
  const activation = Math.max(mode.scheduled ? e?.at ?? doc.generatedAt : 0, doc.manual[mode.id] ?? 0)
  if (!activation) return false
  return !doc.grants.some(g => g.mode === mode.id && (g.target === '' || g.target === targetId) && g.epoch >= activation && g.until > now)
}
export function questions(doc: Document, mode: Mode, now: number, targetId = ''): Question[] {
  if (targetId) {
    const t = mode.targets.find(t => t.id === targetId)
    if (!t || t.category !== 'entertainment') throw new Error('This target requires the mode quiz.')
    return mode.accessQuiz
  }
  return epoch(doc, now)?.phase === 'night' ? mode.nightQuiz : mode.dayQuiz
}
export function quizProgress(quiz: Question[], answers: Answers): { next?: Question; denied: boolean } {
  for (const question of quiz) {
    if (question.when && answers[question.when.id] !== question.when.answer) continue
    if (typeof answers[question.id] !== 'boolean') return { next: question, denied: false }
    if (question.required !== null && answers[question.id] !== question.required) return { denied: true }
  }
  return { denied: false }
}
export function grant(doc: Document, modeId: string, answers: Answers, startedAt: number, now = Date.now(), targetId = ''): Document {
  const mode = doc.modes.find(m => m.id === modeId)
  const e = epoch(doc, now)
  if (!mode || !e || epoch(doc, startedAt)?.at !== e.at || startedAt < (doc.manual[modeId] ?? 0)) throw new Error('The rules changed. Please start the quiz again.')
  const progress = quizProgress(questions(doc, mode, now, targetId), answers)
  if (progress.denied || progress.next) throw new Error('Complete the quiz before continuing.')
  const s = doc.settings
  const minutes = targetId ? s.accessMinutes : mode.id === 'touch-grass' && e.phase === 'night' ? now >= e.late ? s.lateNightMinutes : s.nightMinutes : Infinity
  const until = !mode.scheduled && !targetId && minutes === Infinity ? Number.MAX_SAFE_INTEGER : Math.min(e.end, now + minutes * minute)
  const entry = { mode: modeId, target: targetId, epoch: Math.max(e.at, doc.manual[modeId] ?? 0), until }
  return { ...doc, revision: doc.revision + 1, grants: [...doc.grants.filter(g => !(g.mode === modeId && g.target === targetId)), entry] }
}
export function enableMode(doc: Document, mode: string, now = Date.now()): Document {
  if (!doc.modes.some(m => m.id === mode)) throw new Error('Unknown mode')
  return { ...doc, enabled: true, revision: doc.revision + 1, manual: { ...doc.manual, [mode]: now }, grants: doc.grants.filter(g => g.mode !== mode) }
}
export function matches(target: Target, kind: Target['kind'], value: string): boolean {
  if (kind !== target.kind) return false
  if (kind !== 'domain') return target.value === value
  const host = value.toLowerCase().replace(/\.$/, '')
  const domain = target.value.toLowerCase().replace(/\.$/, '')
  return host === domain || host.endsWith(`.${domain}`)
}
export function validate(doc: Document): void {
  if (doc.version !== 1 || !Array.isArray(doc.modes) || doc.modes.length > 30) throw new Error('Unsupported Situate rules')
  const s = doc.settings
  for (const k of ['wakeMinutes', 'eveningMinutes', 'lateMinutes'] as const) if (!Number.isInteger(s[k]) || s[k] < 0 || s[k] >= 1440) throw new Error('Choose a valid clock time')
  for (const k of ['nightMinutes', 'lateNightMinutes', 'accessMinutes'] as const) if (!Number.isFinite(s[k]) || s[k] < 1 || s[k] > 240) throw new Error('Allow between 1 and 240 minutes')
  for (const k of ['sunsetOffset', 'lateOffset'] as const) if (!Number.isFinite(s[k]) || s[k] < 0 || s[k] > 1440) throw new Error('Sunset offsets must be between 0 and 24 hours')
  if ((s.latitude === null) !== (s.longitude === null) || (s.latitude !== null && (!Number.isFinite(s.latitude) || Math.abs(s.latitude) > 90)) || (s.longitude !== null && (!Number.isFinite(s.longitude) || Math.abs(s.longitude) > 180))) throw new Error('Enter both latitude and longitude')
  const ids = new Set<string>()
  for (const m of doc.modes) {
    if (!/^[a-z0-9-]{1,64}$/.test(m.id) || ids.has(m.id) || !m.name.trim() || m.name.length > 100) throw new Error('Modes need unique IDs and a name')
    ids.add(m.id)
    for (const quiz of [m.dayQuiz, m.nightQuiz, m.accessQuiz]) {
      const seen = new Set<string>()
      if (quiz.length > 50) throw new Error('Use at most 50 questions')
      for (const q of quiz) {
        if (!q.id || seen.has(q.id) || !q.text.trim() || q.text.length > 2000 || ![true, false, null].includes(q.required) || (q.when && !seen.has(q.when.id))) throw new Error('Conditions must refer to an earlier question')
        seen.add(q.id)
      }
    }
    if (m.targets.length > 300) throw new Error('Use at most 300 targets per mode')
    for (const t of m.targets) {
      if (!t.value || t.value.length > 255 || /[\s/\\]/.test(t.value) || !['domain', 'app', 'discord'].includes(t.kind)) throw new Error('Targets use a domain, bundle/package ID, or Discord channel ID')
    }
  }
}
