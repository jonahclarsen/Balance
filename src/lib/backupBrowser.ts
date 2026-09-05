import type { AppState, ListTemplateItem, PlanItem, TemplateItem } from './types'

export type DatabaseBackup = { filename: string; createdAtMs: number; bytes: number }
export type BackupContent = Pick<AppState, 'plans' | 'templates' | 'listTemplates' | 'lists' | 'notes' | 'metrics' | 'metricEntries' | 'goals'>
export type BackupDocument = { id: string; kind: string; title: string; text: string }

function itemLines(items: (PlanItem | ListTemplateItem | TemplateItem)[], depth = 0): string[] {
  return items.flatMap(item => {
    const checkbox = 'done' in item && (!('kind' in item) || item.kind === 'checklist')
    const prefix = `${'  '.repeat(depth)}${checkbox ? (item.done ? '[x] ' : '[ ] ') : ''}`
    const lines = 'options' in item ? item.options.map(option => `${prefix}${option.text}`) : [`${prefix}${item.text}`]
    return [...lines, ...itemLines(item.children ?? [], depth + 1)]
  })
}

// Plain text deliberately avoids executing historical rich HTML or loading
// remote resources embedded in a backup. No content enters the live store.
export function backupDocuments(content: BackupContent): BackupDocument[] {
  const documents: BackupDocument[] = []
  const add = (kind: string, id: string, title: string, lines: string[]) => {
    documents.push({ id: `${kind}:${id}`, kind, title, text: lines.join('\n') })
  }
  for (const plan of content.plans ?? []) add('Plans', plan.id, `${plan.date} · ${plan.title}`, [plan.dailyReminder, ...itemLines(plan.items)])
  for (const note of content.notes ?? []) add('Notes', note.id, `${note.title}${note.deletedAt ? ' (deleted)' : ''}`, itemLines(note.items))
  for (const template of content.templates ?? []) add('Day templates', template.id, template.name, itemLines(template.items))
  for (const template of content.listTemplates ?? []) {
    add('List templates', template.id, template.name, itemLines(template.items))
    if (template.archivedItems?.length) add('Archived list items', template.id, template.name,
      template.archivedItems.flatMap(archive => [archive.archivedDate, ...itemLines([archive.item])]))
  }
  for (const list of content.lists ?? []) add('Lists', list.id,
    `${list.date} · ${content.listTemplates?.find(template => template.id === list.listTemplateId)?.name ?? 'List'}`, itemLines(list.items))
  for (const metric of content.metrics ?? []) add('Metrics', metric.id, metric.name, metric.questions.map(question => question.prompt))
  for (const entry of content.metricEntries ?? []) {
    const metric = content.metrics?.find(metric => metric.id === entry.metricId)
    add('Metric entries', entry.id, `${entry.date} · ${metric?.name ?? 'Metric'}`, entry.answers.map(answer =>
      `${metric?.questions.find(question => question.id === answer.questionId)?.prompt ?? 'Answer'}: ${answer.value}`))
  }
  for (const goal of content.goals ?? []) add('Goals', goal.id, goal.name, [
    `Every ${goal.cadenceDays} day(s)`, `Matching terms: ${goal.matchTerms.join(', ')}`,
    ...goal.activityPeriods.map(period => `${period.startDate} – ${period.endDate ?? 'ongoing'}`),
  ])
  return documents.sort((a, b) => b.title.localeCompare(a.title))
}
