import { expect, test } from '@playwright/test'
import { createPlanItem, createInitialState } from '../../src/lib/planner'
import { alignTranscript, awaitingTranscription, reconcileVoiceClips, timeRangeForSelection, tokenAtTime } from '../../src/lib/voiceClips'
import type { AppState, IdeaGroupKind, VoiceClip, VoiceWord } from '../../src/lib/types'

const words: VoiceWord[] = [
  { text: 'Remember', start: 0, end: 0.3 },
  { text: 'to', start: 0.3, end: 0.4 },
  { text: 'buy', start: 0.4, end: 0.7 },
  { text: 'oat', start: 0.7, end: 1 },
  { text: 'milk.', start: 1, end: 1.3 },
]

test('unedited transcripts take each word’s own time', () => {
  const tokens = alignTranscript('Remember to buy oat milk.', words, 2)
  expect(tokens.map((token) => [token.start, token.end])).toEqual(words.map((word) => [word.start, word.end]))
  expect(timeRangeForSelection(tokens, 12, 19)).toEqual({ start: 0.4, end: 1 })
  expect(tokenAtTime(tokens, 0.75)).toMatchObject({ from: 16, to: 19 })
})

test('edited text keeps matched words and spreads new ones between them', () => {
  // "buy" was misheard and corrected, and a word was added at the end.
  const text = 'remember to get oat milk today'
  const tokens = alignTranscript(text, words, 2)
  expect(tokens[0]).toMatchObject({ start: 0, end: 0.3 })
  expect(tokens[2]).toMatchObject({ start: 0.4, end: 0.7 })
  expect(tokens[4]).toMatchObject({ start: 1, end: 1.3 })
  expect(tokens[5]).toMatchObject({ start: 1.3, end: 2 })
  // A caret inside a word maps to that word.
  expect(timeRangeForSelection(tokens, text.indexOf('oat') + 1, text.indexOf('oat') + 1)).toEqual({ start: 0.7, end: 1 })
})

test('text typed without a transcript is spread across the recording', () => {
  const tokens = alignTranscript('one two three four', [], 4)
  expect(tokens.map((token) => token.start)).toEqual([0, 1, 2, 3])
})

function stateWith(kind: IdeaGroupKind, clip: Partial<VoiceClip> = {}): AppState {
  const idea = { ...createPlanItem('Synthetic voice idea'), id: 'idea_voice' }
  const state = createInitialState()
  return {
    ...state,
    ideaBuckets: [{ id: `bucket_${kind}`, kind, items: [idea] }],
    voiceClips: [{ id: 'voice_1', ideaId: idea.id, dataURL: 'data:audio/webm;base64,', durationMs: 1000, peaks: [], createdAt: '2026-10-27T00:00:00Z', ...clip }],
  }
}

test('clips are dropped once their idea leaves Proposition Party', () => {
  const waiting = stateWith('proposition')
  const sorted = { ...waiting, ideaBuckets: [{ ...waiting.ideaBuckets[0]!, id: 'bucket_trash', kind: 'trash' as const }] }
  expect(reconcileVoiceClips(waiting, sorted).voiceClips).toEqual([])
  // Unrelated edits keep the clip and the state reference.
  const unrelated = { ...waiting, notes: [] }
  expect(reconcileVoiceClips(waiting, unrelated)).toBe(unrelated)
  // Nesting the idea under another proposition keeps it waiting.
  const parent = { ...createPlanItem('Synthetic parent'), children: waiting.ideaBuckets[0]!.items }
  const nested = { ...waiting, ideaBuckets: [{ ...waiting.ideaBuckets[0]!, items: [parent] }] }
  expect(reconcileVoiceClips(waiting, nested).voiceClips).toHaveLength(1)
})

test('only untranscribed clips hold their ideas back from sorting', () => {
  expect([...awaitingTranscription(stateWith('proposition').voiceClips)]).toEqual(['idea_voice'])
  const transcribed = stateWith('proposition', { transcript: { text: 'Synthetic', words: [], model: 'test', transcribedAt: '2026-10-27T00:00:00Z' } })
  expect(awaitingTranscription(transcribed.voiceClips).size).toBe(0)
})
