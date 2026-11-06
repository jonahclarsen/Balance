import type { AppState, Id, ListTemplateItem, Note, PlanItem, TemplateItem } from './types'
import { isNoteTrashed } from './noteTrash'
import { noteVersionGroupId, noteVersionLabel, noteVersionsOf } from './noteVersions'
import { IDEA_GROUPS } from './ideas'
import { navigationURL } from './navigationLinks'
import { historyDayHeading, PROJECT_BACKSTORY_NOTE_ID, projectHistoryNoteDay } from './projects'
import type { RecoverySearchMatch } from './store'

// Where a result opens. Most places have a balance:// link; the rest are
// spots links can't address.
export type SearchTarget =
  | { kind: 'link'; url: string }
  | { kind: 'project'; projectId: Id }
  | { kind: 'project-history'; itemId: Id | null }
  // An archived list shows only in List History.
  | { kind: 'list-history'; listTemplateId: Id }
  | { kind: 'deleted-list-items'; listTemplateId: Id }
  | { kind: 'history'; historyId: string }

export type SearchGroupKind =
  | 'note' | 'idea' | 'goal' | 'project' | 'quiz' | 'list-template' | 'day-template' | 'day' | 'list' | 'history'

export type SearchResult = {
  kind: SearchGroupKind
  id: string
  title: string
  meta: string
  preview: string
  target: SearchTarget
}

type SearchLine = { itemId: Id; text: string }

function link(kind: Parameters<typeof navigationURL>[0], id: string, itemId?: Id | null, date?: string): SearchTarget {
  return { kind: 'link', url: navigationURL(kind, id, itemId ?? undefined, date) }
}

export function searchBalanceState(state: AppState, query: string): SearchResult[] {
  const terms = normalizedTerms(query)
  if (terms.length === 0) return []

  // Keep this cache within one search so locale and timezone changes take
  // effect on the next search, without constructing a formatter for every day.
  let dateFormatter: Intl.DateTimeFormat | undefined
  function formatDate(date: string): string {
    const parsed = new Date(`${date}T12:00:00`)
    if (Number.isNaN(parsed.getTime())) return date
    dateFormatter ??= new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    })
    return dateFormatter.format(parsed)
  }

  const questions = new Map(state.templateQuestions.map((record) => [record.id, record.question]))

  const dayResults: SearchResult[] = [...state.plans]
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap((plan) => {
      const lines = flattenPlanItems(plan.items)
      const formattedDate = formatDate(plan.date)
      const fields = [plan.date, formattedDate, plan.title, plan.dailyReminder, ...lines.map((line) => line.text)]
      if (!matchesTerms(fields.join(' '), terms)) return []

      const match = bestLine(lines, terms)
      return [{
        kind: 'day' as const,
        id: plan.id,
        title: plan.title || formattedDate,
        meta: `Saved day · ${formattedDate}`,
        preview: previewText(match?.text || plan.dailyReminder || lines[0]?.text || 'No item text'),
        target: match ? link('task', match.itemId) : link('day', plan.date),
      }]
    })

  const listTemplateNames = new Map(state.listTemplates.map((template) => [template.id, template.name]))
  const listResults: SearchResult[] = [...state.lists]
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap((list) => {
      const lines = flattenPlanItems(list.items)
      const formattedDate = formatDate(list.date)
      const title = listTemplateNames.get(list.listTemplateId) || 'Untitled list'
      const fields = [list.date, formattedDate, title, ...lines.map((line) => line.text)]
      if (!matchesTerms(fields.join(' '), terms)) return []

      const match = bestLine(lines, terms)
      return [{
        kind: 'list' as const,
        id: list.id,
        title,
        meta: `List History · ${formattedDate}`,
        preview: previewText(match?.text || lines[0]?.text || 'No item text'),
        target: link('list', list.id, match?.itemId),
      }]
    })

  const dayTemplateResults: SearchResult[] = state.templates.flatMap((template) => {
    const lines = flattenDayTemplateItems(template.items, questions)
    if (!matchesTerms([template.name, ...lines.map((line) => line.text)].join(' '), terms)) return []

    const match = bestLine(lines, terms)
    return [{
      kind: 'day-template' as const,
      id: template.id,
      title: template.name || 'Untitled day template',
      meta: 'Day template',
      preview: previewText(match?.text || lines[0]?.text || 'No item text'),
      target: link('day-template', template.id, match?.itemId),
    }]
  })

  const listTemplateResults: SearchResult[] = state.listTemplates.flatMap((template) => {
    const title = template.name || 'Untitled list'
    const results: SearchResult[] = []
    const lines = flattenListTemplateItems(template.items, questions)
    if (matchesTerms([template.name, ...lines.map((line) => line.text)].join(' '), terms)) {
      const match = bestLine(lines, terms)
      results.push({
        kind: 'list-template',
        id: template.id,
        title,
        meta: template.archivedAt ? 'List · Archived' : 'List',
        preview: previewText(match?.text || lines[0]?.text || 'No item text'),
        target: template.archivedAt
          ? { kind: 'list-history', listTemplateId: template.id }
          : link('list-template', template.id, match?.itemId),
      })
    }
    const deletedLines = flattenListTemplateItems(template.archivedItems.map((archived) => archived.item), questions)
    const deletedMatch = deletedLines.find((line) => matchesTerms(`${template.name} ${line.text}`, terms))
    if (deletedMatch) {
      results.push({
        kind: 'list-template',
        id: `${template.id}:deleted`,
        title,
        meta: 'List · Deleted items',
        preview: previewText(deletedMatch.text),
        target: template.archivedAt
          ? { kind: 'list-history', listTemplateId: template.id }
          : { kind: 'deleted-list-items', listTemplateId: template.id },
      })
    }
    return results
  })

  const activeNotes = state.notes.filter((note) => !isNoteTrashed(note))
  const trashedNotes = state.notes.filter(isNoteTrashed)
  const versionedGroups = new Set(activeNotes.filter((note) => note.versionOf).map((note) => note.versionOf))
  const versionsByGroup = new Map<Id, Note[]>()
  function versionLabel(note: Note): string {
    const groupId = noteVersionGroupId(note)
    let versions = versionsByGroup.get(groupId)
    if (!versions) {
      versions = noteVersionsOf(activeNotes, groupId)
      versionsByGroup.set(groupId, versions)
    }
    return noteVersionLabel(note, versions)
  }
  function noteMeta(note: Note): string {
    if (isNoteTrashed(note)) return 'Note · Trash'
    return versionedGroups.has(noteVersionGroupId(note)) ? `Note · ${versionLabel(note)}` : 'Note'
  }
  const byRecentUpdate = (a: Note, b: Note) => b.updatedAt.localeCompare(a.updatedAt)
  const noteResults: SearchResult[] = [...activeNotes.sort(byRecentUpdate), ...trashedNotes.sort(byRecentUpdate)]
    .flatMap((note) => {
      const lines = flattenPlanItems(note.items)
      if (!matchesTerms([note.title, ...lines.map((line) => line.text)].join(' '), terms)) return []
      const match = bestLine(lines, terms)
      return [{
        kind: 'note' as const,
        id: note.id,
        title: note.title || 'Untitled note',
        meta: noteMeta(note),
        preview: previewText(match?.text || lines[0]?.text || 'Empty note'),
        target: link('note', note.id, match?.itemId),
      }]
    })

  const transcripts = new Map(state.voiceClips.flatMap((clip) => clip.transcript?.text ? [[clip.ideaId, clip.transcript.text]] : []))
  const ideaResults: SearchResult[] = IDEA_GROUPS.flatMap((group) => {
    const items = state.ideaBuckets.find((bucket) => bucket.kind === group.kind)?.items ?? []
    return items.flatMap((idea) => {
      const lines = flattenPlanItems([idea])
      const transcript = transcripts.get(idea.id) ?? ''
      if (!matchesTerms([...lines.map((line) => line.text), transcript].join(' '), terms)) return []
      const match = bestLine(lines, terms)
      return [{
        kind: 'idea' as const,
        id: idea.id,
        title: previewText(idea.text) || 'Untitled idea',
        meta: `Idea · ${group.label}`,
        preview: previewText((match && match.itemId !== idea.id ? match.text : '') || (match ? '' : transcript)),
        target: link('task', match?.itemId ?? idea.id),
      }]
    })
  })

  const goalResults: SearchResult[] = state.goals.flatMap((goal) => {
    const fields = [goal.name, ...goal.matchTerms]
    if (!matchesTerms(fields.join(' '), terms)) return []
    return [{
      kind: 'goal' as const,
      id: goal.id,
      title: goal.name || 'Untitled goal',
      meta: 'Goal',
      preview: previewText(goal.matchTerms.join(', ')),
      target: link('goal', goal.id),
    }]
  })

  const projectResults: SearchResult[] = state.projects.flatMap((project) => {
    if (!matchesTerms(`${project.name} ${project.description}`, terms)) return []
    const status = project.archived ? ' · Archived' : project.completedAt ? ' · Completed' : ''
    return [{
      kind: 'project' as const,
      id: project.id,
      title: project.name || 'Untitled project',
      meta: `Project${status}`,
      preview: previewText(project.description),
      target: { kind: 'project' as const, projectId: project.id },
    }]
  })
  const projectHistoryResults: SearchResult[] = [...state.projectHistoryNotes]
    .sort((a, b) => b.id.localeCompare(a.id))
    .flatMap((note) => {
      const day = projectHistoryNoteDay(note.id)
      if (!day && note.id !== PROJECT_BACKSTORY_NOTE_ID) return []
      const heading = day ? historyDayHeading(day) : 'backstory'
      const lines = flattenPlanItems(note.items)
      if (!matchesTerms([heading, ...lines.map((line) => line.text)].join(' '), terms)) return []
      const match = bestLine(lines, terms)
      return [{
        kind: 'project' as const,
        id: note.id,
        title: heading,
        meta: 'Project History',
        preview: previewText(match?.text || lines[0]?.text || ''),
        target: { kind: 'project-history' as const, itemId: match?.itemId ?? null },
      }]
    })

  const metricsById = new Map(state.metrics.map((metric) => [metric.id, metric]))
  const quizResults: SearchResult[] = state.metrics.flatMap((metric) => {
    const lines = metric.questions.map((question) => ({ itemId: question.id, text: question.prompt }))
    if (!matchesTerms([metric.name, ...lines.map((line) => line.text)].join(' '), terms)) return []
    const match = bestLine(lines, terms)
    return [{
      kind: 'quiz' as const,
      id: metric.id,
      title: metric.name || 'Untitled quiz',
      meta: metric.archivedAt ? 'Quiz · Archived' : 'Quiz',
      preview: previewText(match?.text || lines[0]?.text || 'No questions'),
      target: link('quiz', metric.id, match?.itemId),
    }]
  })
  // Only typed answers; y/n and numbers would match almost any short query.
  const quizAnswerResults: SearchResult[] = [...state.metricEntries]
    .sort((a, b) => b.date.localeCompare(a.date))
    .flatMap((entry) => {
      const metric = metricsById.get(entry.metricId)
      if (!metric) return []
      const answers = entry.answers.flatMap((answer) => {
        const question = metric.questions.find((candidate) => candidate.id === answer.questionId)
        return question?.type === 'text' && answer.value.trim()
          ? [{ itemId: question.id, text: `${question.prompt}: ${answer.value}` }]
          : []
      })
      if (answers.length === 0) return []
      const formattedDate = formatDate(entry.date)
      if (!matchesTerms([metric.name, entry.date, formattedDate, ...answers.map((line) => line.text)].join(' '), terms)) return []
      const match = bestLine(answers, terms) ?? answers[0]
      return [{
        kind: 'quiz' as const,
        id: entry.id,
        title: metric.name || 'Untitled quiz',
        meta: `Answers · ${formattedDate}`,
        preview: previewText(match.text),
        target: link('quiz', metric.id, match.itemId, entry.date),
      }]
    })

  return [
    ...noteResults,
    ...ideaResults,
    ...goalResults,
    ...projectResults,
    ...projectHistoryResults,
    ...quizResults,
    ...quizAnswerResults,
    ...dayResults,
    ...listResults,
    ...dayTemplateResults,
    ...listTemplateResults,
  ]
}

export function recoveryMatchesToSearchResults(entries: RecoverySearchMatch[]): SearchResult[] {
  let dateFormatter: Intl.DateTimeFormat | undefined
  function formatHistoryDate(entry: RecoverySearchMatch): string {
    const timestamp = entry.timestamp ? Date.parse(entry.timestamp) : entry.createdAtMs
    if (!Number.isFinite(timestamp)) return 'unknown time'
    dateFormatter ??= new Intl.DateTimeFormat(undefined, {
      dateStyle: 'medium',
      timeStyle: 'short',
    })
    return dateFormatter.format(new Date(timestamp))
  }

  return entries.map((entry) => ({
    kind: 'history' as const,
    id: entry.historyId,
    title: historyTitle(entry.operationType),
    meta: `Previous state · ${formatHistoryDate(entry)}`,
    preview: previewText(entry.preview || 'Saved change'),
    target: { kind: 'history' as const, historyId: entry.historyId },
  }))
}

function historyTitle(operationType: string | null): string {
  if (!operationType) return 'Earlier saved state'
  if (operationType.includes('delete') || operationType.includes('backspace')) return 'Removed content'
  if (operationType.includes('patch') || operationType.includes('rename')) return 'Earlier text'
  if (operationType.includes('generate')) return 'Replaced content'
  return 'Earlier saved state'
}

function normalizedTerms(query: string): string[] {
  return normalize(query).split(/\s+/).filter(Boolean)
}

function normalize(value: string): string {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
}

function matchesTerms(value: string, terms: string[]): boolean {
  const haystack = normalize(value)
  return terms.every((term) => haystack.includes(term))
}

function bestLine(lines: SearchLine[], terms: string[]): SearchLine | null {
  return lines.find((line) => matchesTerms(line.text, terms))
    ?? lines.find((line) => terms.some((term) => normalize(line.text).includes(term)))
    ?? null
}

function flattenPlanItems(items: PlanItem[]): SearchLine[] {
  return items.flatMap((item) => [
    { itemId: item.id, text: item.text },
    ...flattenPlanItems(item.children),
  ])
}

function questionLine(itemId: Id, questions: Map<Id, string>): SearchLine[] {
  const question = questions.get(itemId)
  return question ? [{ itemId, text: question }] : []
}

function flattenDayTemplateItems(items: TemplateItem[], questions: Map<Id, string>): SearchLine[] {
  return items.flatMap((item) => [
    ...questionLine(item.id, questions),
    ...item.options.map((option) => ({ itemId: item.id, text: option.text })),
    ...flattenDayTemplateItems(item.children, questions),
  ])
}

function flattenListTemplateItems(items: ListTemplateItem[], questions: Map<Id, string>): SearchLine[] {
  return items.flatMap((item) => [
    ...questionLine(item.id, questions),
    { itemId: item.id, text: item.text },
    ...(item.alternatives ?? []).map((alternative) => ({ itemId: item.id, text: alternative.text })),
    ...flattenListTemplateItems(item.children, questions),
  ])
}

function previewText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 180 ? `${compact.slice(0, 177)}…` : compact
}
