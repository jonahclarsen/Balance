import { expect, test } from '@playwright/test'
import { createInitialState } from '../../src/lib/planner'
import { noteVersionGroupId, noteVersionLabel, noteVersionsOf } from '../../src/lib/noteVersions'
import { recoveryMatchesToSearchResults, searchBalanceState } from '../../src/lib/search'
import type { AppState, Note, NoteItem, PlanItem } from '../../src/lib/types'

function emptyState(): AppState {
  return { ...createInitialState(), plans: [], lists: [], templates: [], listTemplates: [], notes: [] }
}

function item(id: string, text: string, children: PlanItem[] = []): PlanItem {
  return { id, text, html: text, done: false, startMinutes: null, endMinutes: null, children }
}

function note(id: string, extra: Partial<Note> = {}): Note {
  return { id, title: 'Café planning', items: [], createdAt: '2026-01-01', updatedAt: '2026-01-01', ...extra }
}

function formattedDay(date: string): string {
  const parsed = new Date(`${date}T12:00:00`)
  return Number.isNaN(parsed.getTime()) ? date : new Intl.DateTimeFormat(undefined, {
    weekday: 'short', year: 'numeric', month: 'short', day: 'numeric',
  }).format(parsed)
}

test('search keeps result order, normalized matching, nested previews and alternative destinations', () => {
  const state = emptyState()
  state.plans = ['2026-01-01', '2026-02-01'].map((date) => ({
    id: date, date, title: 'Café', dailyReminder: 'planning', createdAt: '', generatedFromTemplateId: null,
    items: [item(`${date}-parent`, 'planning', [item(`${date}-child`, 'CAFÉ planning together')])],
  }))
  state.listTemplates = [{
    id: 'list-template', name: 'Errands', createdAt: '', updatedAt: '', maxExpectedWords: 0, archivedItems: [],
    items: [{ id: 'alternative-row', text: 'Original', html: '', probability: 100, children: [],
      alternatives: [{ id: 'alternative', text: 'Café planning', html: '', probability: 50 }] }],
  }, {
    id: 'archived', name: 'Café planning archived', archivedAt: '2026-01-01', createdAt: '', updatedAt: '',
    maxExpectedWords: 0, archivedItems: [], items: [],
  }]
  state.lists = [{
    id: 'list', listTemplateId: 'archived', date: '2026-03-01', createdAt: '',
    items: [item('list-parent', 'Café', [item('list-child', 'planning')])],
  }]
  state.templates = [{
    id: 'template', name: 'Day', createdAt: '', updatedAt: '',
    items: [{ id: 'template-row', startMinutes: null, endMinutes: null, children: [],
      options: [{ id: 'option', text: 'Café planning', html: '', probability: 100 }] }],
  }]
  state.notes = [note('note', {
    items: [{ ...item('note-row', '  Café \n planning  '), kind: 'paragraph' } as NoteItem],
  }), note('trashed', { deletedAt: '2026-01-01' })]
  const before = structuredClone(state)
  const results = searchBalanceState(state, ' CAFE   planning ')
  expect(results.map(({ kind, id, meta, preview }) => ({ kind, id, meta, preview }))).toEqual([
    { kind: 'note', id: 'note', meta: 'Note', preview: 'Café planning' },
    { kind: 'note', id: 'trashed', meta: 'Note · Trash', preview: 'Empty note' },
    { kind: 'day', id: '2026-02-01', meta: `Saved day · ${formattedDay('2026-02-01')}`, preview: 'CAFÉ planning together' },
    { kind: 'day', id: '2026-01-01', meta: `Saved day · ${formattedDay('2026-01-01')}`, preview: 'CAFÉ planning together' },
    { kind: 'list', id: 'list', meta: `List History · ${formattedDay('2026-03-01')}`, preview: 'Café' },
    { kind: 'day-template', id: 'template', meta: 'Day template', preview: 'Café planning' },
    { kind: 'list-template', id: 'list-template', meta: 'List', preview: 'Café planning' },
    { kind: 'list-template', id: 'archived', meta: 'List · Archived', preview: 'No item text' },
  ])
  expect(results.map((result) => result.target)).toEqual([
    { kind: 'link', url: 'balance://note/note?item=note-row' },
    { kind: 'link', url: 'balance://note/trashed' },
    { kind: 'link', url: 'balance://task/2026-02-01-child' },
    { kind: 'link', url: 'balance://task/2026-01-01-child' },
    { kind: 'link', url: 'balance://list/list?item=list-parent' },
    { kind: 'link', url: 'balance://day-template/template?item=template-row' },
    { kind: 'link', url: 'balance://list-template/list-template?item=alternative-row' },
    { kind: 'list-history', listTemplateId: 'archived' },
  ])
  expect(searchBalanceState(state, '\t\n')).toEqual([])
  expect(searchBalanceState(state, 'missing')).toEqual([])
  expect(state).toEqual(before)
})

test('saved dates retain their locale formatting, invalid-date fallback, and searchable labels', () => {
  const state = emptyState()
  const dates = ['2026-03-08', '2026-11-01', 'invalid-date']
  state.plans = dates.map((date) => ({
    id: date, date, title: '', dailyReminder: 'needle', items: [], createdAt: '', generatedFromTemplateId: null,
  }))
  const results = searchBalanceState(state, 'needle')
  for (const date of dates) {
    expect(results.find((result) => result.id === date)).toEqual({
      kind: 'day', id: date, title: formattedDay(date),
      meta: `Saved day · ${formattedDay(date)}`, preview: 'needle', target: { kind: 'link', url: `balance://day/${date}` },
    })
    expect(searchBalanceState(state, formattedDay(date)).some((result) => result.id === date)).toBe(true)
  }
})

test('version labels retain creation order, names and active membership across searches', () => {
  const state = emptyState()
  state.notes = [
    note('a', { updatedAt: '2026-04-01' }),
    note('c', { versionOf: 'a', createdAt: '2026-02-01' }),
    note('b', { versionOf: 'a', createdAt: '2026-02-01', versionName: '  Named draft  ' }),
    note('deleted', { versionOf: 'a', deletedAt: '2026-03-01', createdAt: '2025-01-01' }),
    note('orphan', { versionOf: 'missing' }),
    note('ordinary'),
    note('other', { versionOf: 'ordinary', versionName: '  ' }),
  ]
  function assertLabels() {
    const active = state.notes.filter((entry) => !entry.deletedAt)
    const versionedGroups = new Set(active.filter((entry) => entry.versionOf).map((entry) => entry.versionOf))
    const results = searchBalanceState(state, 'cafe').filter((result) => result.meta !== 'Note · Trash')
    expect(results.map((result) => result.id)).toEqual(
      [...active].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map((entry) => entry.id),
    )
    for (const entry of active) {
      const groupId = noteVersionGroupId(entry)
      const label = versionedGroups.has(groupId)
        ? `Note · ${noteVersionLabel(entry, noteVersionsOf(active, groupId))}` : 'Note'
      expect(results.find((result) => result.id === entry.id)?.meta).toBe(label)
    }
  }
  assertLabels()
  state.notes[0].deletedAt = '2026-04-02'
  state.notes[1].createdAt = '2025-01-01'
  state.notes[2].versionName = ''
  state.notes.push(note('new', { versionOf: 'a', createdAt: '2026-05-01' }))
  assertLabels()
})

test('search finds ideas in every group, goals, projects, quizzes, template questions and deleted list items', () => {
  const state = emptyState()
  state.ideaBuckets = [
    { id: 'bucket_trash', kind: 'trash', items: [{ ...item('trashed-idea', 'Build a quince press') }] },
    { id: 'bucket_proposition', kind: 'proposition', items: [
      { ...item('spoken', 'Voice memo') },
      { ...item('parent-idea', 'Garden', [item('child-idea', 'Plant quince trees')]) },
    ] },
  ]
  state.voiceClips = [{
    id: 'clip', ideaId: 'spoken', dataURL: '', durationMs: 1, peaks: [], createdAt: '',
    transcript: { text: 'what about quince jam', words: [], model: 'test', transcribedAt: '' },
  }]
  state.goals = [{
    id: 'goal', name: 'Orchard', nameHtml: 'Orchard', cadenceDays: 7, matchTerms: ['quince'], matchTermsHtml: 'quince',
    hue: 0, lightness: 50, activityPeriods: [], createdAt: '', updatedAt: '',
  }]
  state.projects = [{
    id: 'project', name: 'Quince orchard', description: 'Old trees', color: '#000', archived: true, createdAt: '', updatedAt: '',
  }]
  state.projectHistoryNotes = [{
    id: 'project-history-2026-05-04', createdAt: '', updatedAt: '',
    items: [{ ...item('history-row', 'Pruned the quince'), kind: 'paragraph' } as NoteItem],
  }]
  state.metrics = [{
    id: 'quiz', name: 'Evening', archivedAt: '2026-01-01', createdAt: '', updatedAt: '',
    questions: [{ id: 'q-text', prompt: 'Best fruit?', html: '', type: 'text' }, { id: 'q-bool', prompt: 'Quince?', html: '', type: 'boolean' }],
  }]
  state.metricEntries = [{
    id: 'entry', metricId: 'quiz', date: '2026-05-04', createdAt: '', updatedAt: '',
    answers: [{ questionId: 'q-text', value: 'quince' }, { questionId: 'q-bool', value: 'y' }],
  }]
  state.templates = [{
    id: 'template', name: 'Day', createdAt: '', updatedAt: '',
    items: [{ id: 'asked', startMinutes: null, endMinutes: null, children: [], options: [{ id: 'o', text: 'Yes', html: '', probability: 100 }] }],
  }]
  state.templateQuestions = [{ id: 'asked', question: 'Pick quince today?' }]
  state.listTemplates = [{
    id: 'errands', name: 'Errands', createdAt: '', updatedAt: '', maxExpectedWords: 0, items: [],
    archivedItems: [{ id: 'gone', parentId: null, position: 0, archivedAt: '', archivedDate: '',
      item: { id: 'gone-item', text: 'Buy quince paste', html: '', probability: 100, children: [] } }],
  }]

  const results = searchBalanceState(state, 'quince')
  expect(results.map(({ kind, id, meta, preview, target }) => ({ kind, id, meta, preview, target }))).toEqual([
    { kind: 'idea', id: 'spoken', meta: 'Idea · Proposition Party', preview: 'what about quince jam', target: { kind: 'link', url: 'balance://task/spoken' } },
    { kind: 'idea', id: 'parent-idea', meta: 'Idea · Proposition Party', preview: 'Plant quince trees', target: { kind: 'link', url: 'balance://task/child-idea' } },
    { kind: 'idea', id: 'trashed-idea', meta: 'Idea · Trash', preview: '', target: { kind: 'link', url: 'balance://task/trashed-idea' } },
    { kind: 'goal', id: 'goal', meta: 'Goal', preview: 'quince', target: { kind: 'link', url: 'balance://goal/goal' } },
    { kind: 'project', id: 'project', meta: 'Project · Archived', preview: 'Old trees', target: { kind: 'project', projectId: 'project' } },
    { kind: 'project', id: 'project-history-2026-05-04', meta: 'Project History', preview: 'Pruned the quince', target: { kind: 'project-history', itemId: 'history-row' } },
    { kind: 'quiz', id: 'quiz', meta: 'Quiz · Archived', preview: 'Quince?', target: { kind: 'link', url: 'balance://quiz/quiz?item=q-bool' } },
    { kind: 'quiz', id: 'entry', meta: `Answers · ${formattedDay('2026-05-04')}`, preview: 'Best fruit?: quince', target: { kind: 'link', url: 'balance://quiz/quiz?item=q-text&date=2026-05-04' } },
    { kind: 'day-template', id: 'template', meta: 'Day template', preview: 'Pick quince today?', target: { kind: 'link', url: 'balance://day-template/template?item=asked' } },
    { kind: 'list-template', id: 'errands:deleted', meta: 'List · Deleted items', preview: 'Buy quince paste', target: { kind: 'deleted-list-items', listTemplateId: 'errands' } },
  ])
})

test('recovery dates preserve timestamp precedence, unknown times and preview formatting', () => {
  const entries = [
    { historyId: 'timestamp', operationType: 'delete_note', timestamp: '2026-03-08T09:00:00Z', createdAtMs: 0, preview: '  removed\ntext  ' },
    { historyId: 'fallback', operationType: 'rename_note', timestamp: null, createdAtMs: 1000, preview: '' },
    { historyId: 'invalid', operationType: null, timestamp: 'bad', createdAtMs: 1000, preview: 'x'.repeat(200) },
    { historyId: 'missing', operationType: 'generate_day', timestamp: null, createdAtMs: NaN, preview: '' },
  ]
  const results = recoveryMatchesToSearchResults(entries)
  const formatter = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' })
  expect(results.map((result) => result.meta)).toEqual([
    `Previous state · ${formatter.format(new Date(entries[0].timestamp!))}`,
    `Previous state · ${formatter.format(new Date(1000))}`,
    'Previous state · unknown time', 'Previous state · unknown time',
  ])
  expect(results.map((result) => result.title)).toEqual(['Removed content', 'Earlier text', 'Earlier saved state', 'Replaced content'])
  expect(results.map((result) => result.preview)).toEqual(['removed text', 'Saved change', `${'x'.repeat(177)}…`, 'Saved change'])
  expect(recoveryMatchesToSearchResults([])).toEqual([])
})
