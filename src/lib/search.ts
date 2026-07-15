import type { AppState, Id, ListTemplateItem, PlanItem, TemplateItem } from './types'

export type SearchResult =
  | {
      kind: 'day'
      id: Id
      title: string
      meta: string
      preview: string
      date: string
      itemId: Id | null
    }
  | {
      kind: 'list'
      id: Id
      title: string
      meta: string
      preview: string
      date: string
      listTemplateId: Id
      itemId: Id | null
    }
  | {
      kind: 'day-template'
      id: Id
      title: string
      meta: string
      preview: string
      templateId: Id
      itemId: Id | null
    }
  | {
      kind: 'list-template'
      id: Id
      title: string
      meta: string
      preview: string
      templateId: Id
      itemId: Id | null
    }

type SearchLine = { itemId: Id; text: string }

export function searchBalanceState(state: AppState, query: string): SearchResult[] {
  const terms = normalizedTerms(query)
  if (terms.length === 0) return []

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
        date: plan.date,
        itemId: match?.itemId ?? null,
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
        meta: `List instance · ${formattedDate}`,
        preview: previewText(match?.text || lines[0]?.text || 'No item text'),
        date: list.date,
        listTemplateId: list.listTemplateId,
        itemId: match?.itemId ?? null,
      }]
    })

  const dayTemplateResults: SearchResult[] = state.templates.flatMap((template) => {
    const lines = flattenDayTemplateItems(template.items)
    if (!matchesTerms([template.name, ...lines.map((line) => line.text)].join(' '), terms)) return []

    const match = bestLine(lines, terms)
    return [{
      kind: 'day-template' as const,
      id: template.id,
      title: template.name || 'Untitled day template',
      meta: 'Day template',
      preview: previewText(match?.text || lines[0]?.text || 'No item text'),
      templateId: template.id,
      itemId: match?.itemId ?? null,
    }]
  })

  const listTemplateResults: SearchResult[] = state.listTemplates.flatMap((template) => {
    const lines = flattenListTemplateItems(template.items)
    if (!matchesTerms([template.name, ...lines.map((line) => line.text)].join(' '), terms)) return []

    const match = bestLine(lines, terms)
    return [{
      kind: 'list-template' as const,
      id: template.id,
      title: template.name || 'Untitled list template',
      meta: 'List template',
      preview: previewText(match?.text || lines[0]?.text || 'No item text'),
      templateId: template.id,
      itemId: match?.itemId ?? null,
    }]
  })

  return [...dayResults, ...listResults, ...dayTemplateResults, ...listTemplateResults]
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

function flattenDayTemplateItems(items: TemplateItem[]): SearchLine[] {
  return items.flatMap((item) => [
    ...item.options.map((option) => ({ itemId: item.id, text: option.text })),
    ...flattenDayTemplateItems(item.children),
  ])
}

function flattenListTemplateItems(items: ListTemplateItem[]): SearchLine[] {
  return items.flatMap((item) => [
    { itemId: item.id, text: item.text },
    ...flattenListTemplateItems(item.children),
  ])
}

function previewText(value: string): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length > 180 ? `${compact.slice(0, 177)}…` : compact
}

function formatDate(date: string): string {
  const parsed = new Date(`${date}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return date
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  }).format(parsed)
}
