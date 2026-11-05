import type { AppState, Id, IdeaGroup, PlanItem, VoiceClip, VoiceWord } from './types'

export const PEAKS_PER_SECOND = 20

function collectIds(items: PlanItem[], ids: Set<Id>) {
  for (const item of items) {
    ids.add(item.id)
    collectIds(item.children, ids)
  }
}

export function propositionIdeaIds(groups: IdeaGroup[]): Set<Id> {
  const ids = new Set<Id>()
  for (const group of groups) if (group.kind === 'proposition') collectIds(group.items, ids)
  return ids
}

// Audio is kept only while its idea waits in Proposition Party, so sorting,
// deleting, merging or moving the idea to a day drops the clip in the same commit.
export function reconcileVoiceClips(before: AppState, after: AppState): AppState {
  if (after.voiceClips.length === 0) return after
  if (before.ideaBuckets === after.ideaBuckets && before.voiceClips === after.voiceClips) return after
  const live = propositionIdeaIds(after.ideaBuckets)
  const voiceClips = after.voiceClips.filter((clip) => live.has(clip.ideaId))
  return voiceClips.length === after.voiceClips.length ? after : { ...after, voiceClips }
}

export function clipsByIdea(clips: VoiceClip[]): Map<Id, VoiceClip> {
  return new Map(clips.map((clip) => [clip.ideaId, clip]))
}

// Untranscribed recordings can't be judged yet, so sorting passes them by.
export function awaitingTranscription(clips: VoiceClip[]): Set<Id> {
  return new Set(clips.filter((clip) => !clip.transcript).map((clip) => clip.ideaId))
}

export function formatClipDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}

// ---- Text ↔ audio alignment -------------------------------------------------

export type TimedToken = { from: number; to: number; start: number; end: number }

const normalizeWord = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, '')

// Longest common subsequence of `tokens` (indices into `all`) and `targets`;
// returns the matched word index per token, or position when too long.
function matchWords(all: { word: string }[], tokens: number[], targets: string[], matched: (number | null)[]) {
  const n = tokens.length
  const m = targets.length
  if (n === 0 || m === 0) return
  if (n * m > 4_000_000) {
    for (let i = 0; i < n; i += 1) matched[tokens[i]!] = Math.min(m - 1, Math.floor((i / n) * m))
    return
  }
  const width = m + 1
  const table = new Uint16Array((n + 1) * width)
  const word = (i: number) => all[tokens[i]!]!.word
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      table[i * width + j] = word(i) && word(i) === targets[j]
        ? table[(i + 1) * width + j + 1]! + 1
        : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!)
    }
  }
  for (let i = 0, j = 0; i < n && j < m;) {
    if (word(i) && word(i) === targets[j]) matched[tokens[i++]!] = j++
    else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i += 1
    else j += 1
  }
}

// Times every whitespace-separated token of `text`, which may have been edited
// since transcription. Tokens matching a transcript word (in order) take its
// time; inserted or rewritten tokens are spread between their matched neighbours.
// Lines that are mostly not from the transcript (text typed before recording)
// stay untimed, with NaN start and end.
export function alignTranscript(text: string, words: VoiceWord[], durationSeconds: number): TimedToken[] {
  const tokens = [...text.matchAll(/\S+/g)].map((match) => ({
    from: match.index,
    to: match.index + match[0].length,
    word: normalizeWord(match[0]),
    line: text.slice(0, match.index).split('\n').length - 1,
  }))
  const targets = words.map((word) => normalizeWord(word.text))
  let timedIndices = tokens.map((_, index) => index)
  let matched: (number | null)[] = new Array(tokens.length).fill(null)
  if (targets.length > 0) {
    matchWords(tokens, timedIndices, targets, matched)
    const counts = new Map<number, { words: number; matched: number }>()
    tokens.forEach((token, index) => {
      if (!token.word) return
      const count = counts.get(token.line) ?? { words: 0, matched: 0 }
      count.words += 1
      if (matched[index] !== null) count.matched += 1
      counts.set(token.line, count)
    })
    const fromTranscript = (line: number) => {
      const count = counts.get(line)
      return count !== undefined && count.matched * 2 >= count.words
    }
    timedIndices = timedIndices.filter((index) => fromTranscript(tokens[index]!.line))
    // Words in the dropped lines may have claimed transcript words; match again without them.
    matched = new Array(tokens.length).fill(null)
    matchWords(tokens, timedIndices, targets, matched)
  }
  const timed: TimedToken[] = tokens.map((token, index) => {
    const word = matched[index] === null ? null : words[matched[index]!]!
    return { from: token.from, to: token.to, start: word?.start ?? NaN, end: word?.end ?? NaN }
  })
  // Fill gaps between anchors proportionally.
  const n = timedIndices.length
  for (let i = 0; i < n;) {
    if (!Number.isNaN(timed[timedIndices[i]!]!.start)) { i += 1; continue }
    let j = i
    while (j < n && Number.isNaN(timed[timedIndices[j]!]!.start)) j += 1
    const from = i > 0 ? timed[timedIndices[i - 1]!]!.end : 0
    const to = j < n ? timed[timedIndices[j]!]!.start : durationSeconds
    const step = (to - from) / (j - i)
    for (let k = i; k < j; k += 1) {
      const index = timedIndices[k]!
      timed[index] = { ...timed[index]!, start: from + step * (k - i), end: from + step * (k - i + 1) }
    }
    i = j
  }
  return timed
}

export const isTimed = (token: TimedToken) => !Number.isNaN(token.start)

// The audio span covering a text selection; a caret maps to the token it touches.
// Selections only in untimed text have no span.
export function timeRangeForSelection(tokens: TimedToken[], from: number, to: number): { start: number; end: number } | null {
  if (!tokens.some(isTimed)) return null
  const touches = (token: TimedToken) => from === to ? token.from <= from && from <= token.to : token.to > from && token.from < to
  const touched = tokens.filter((token) => isTimed(token) && touches(token))
  if (touched.length === 0) {
    if (tokens.some(touches)) return null
    const timed = tokens.filter(isTimed)
    const next = timed.find((token) => token.from >= from) ?? timed.at(-1)!
    return { start: next.start, end: next.end }
  }
  return { start: touched[0]!.start, end: touched.at(-1)!.end }
}

export function tokenAtTime(tokens: TimedToken[], seconds: number): TimedToken | null {
  let found: TimedToken | null = null
  for (const token of tokens) {
    if (!isTimed(token)) continue
    if (token.start > seconds) break
    found = token
  }
  return found ?? tokens.find(isTimed) ?? null
}
