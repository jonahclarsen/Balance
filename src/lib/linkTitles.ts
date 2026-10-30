import { IDEA_REVIEW_LABELS, ideasLinkFromURL } from './ideaLinks'
import { IDEA_GROUPS } from './ideas'
import { parseNavigationURL, type LinkableView } from './navigationLinks'
import { escapeHTML, isGoalStatsURL, noteIdFromURL, projectIdFromURL, templateReviewFromURL, templateReviewLabel } from './planner'
import type { AppState, Id } from './types'

type LinkTitleState = Pick<AppState, 'notes' | 'projects' | 'templates' | 'listTemplates' | 'lists' | 'plans' | 'metrics' | 'goals' | 'ideaBuckets'>
type Tree = { id: Id; children: Tree[] }

const VIEW_TITLES: Record<LinkableView, string> = {
  situate: 'Situate', next: 'Next', today: 'Today', templates: 'Days', listTemplates: 'Lists', lists: 'List History',
  notes: 'Notes', projects: 'Projects', projectHistory: 'Project History', prioritize: 'Prioritize', ideas: 'Ideas', metrics: 'Quizzes', goals: 'Goals', settings: 'Settings',
}

function findItem<T extends Tree>(items: T[], id: Id): T | null {
  for (const item of items) {
    if (item.id === id) return item
    const child = findItem(item.children as T[], id)
    if (child) return child
  }
  return null
}

function shorten(text: string | undefined): string {
  const line = (text ?? '').split('\n')[0].trim()
  return line.length > 80 ? `${line.slice(0, 79).trimEnd()}…` : line
}

// A pasted balance:// link shows as its target's name. Null when the target
// is gone, so the raw link stays visible instead of a misleading title.
export function balanceLinkTitle(value: string, state: LinkTitleState): string | null {
  const url = value.trim()
  const noteId = noteIdFromURL(url)
  if (noteId) {
    const note = state.notes.find((note) => note.id === noteId)
    return note ? shorten(note.title) || 'Untitled note' : null
  }
  const projectId = projectIdFromURL(url)
  if (projectId === '') return 'Projects'
  if (projectId !== null) return shorten(state.projects.find((project) => project.id === projectId)?.name) || null
  if (isGoalStatsURL(url)) return 'Goal stats'
  const ideas = ideasLinkFromURL(url)
  if (ideas) return ideas === 'page' ? 'Ideas' : IDEA_REVIEW_LABELS[ideas]
  const review = templateReviewFromURL(url)
  if (review) return templateReviewLabel(review.kind)

  const target = parseNavigationURL(url)
  if (!target) return null
  if (target.kind === 'page') return VIEW_TITLES[target.view]
  if (target.kind === 'day') return new Date(`${target.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
  if (target.kind === 'note') return shorten(state.notes.find((note) => note.id === target.id)?.title) || null
  if (target.kind === 'task') {
    for (const container of [...state.plans, ...state.lists, ...state.ideaBuckets]) {
      const item = findItem(container.items, target.id)
      if (item) return shorten(item.text) || null
    }
    return null
  }
  if (target.kind === 'day-template') {
    const template = state.templates.find((template) => template.id === target.id)
    if (!template) return null
    return target.itemId ? shorten(findItem(template.items, target.itemId)?.options[0]?.text) || null : shorten(template.name) || null
  }
  if (target.kind === 'list-template') {
    const template = state.listTemplates.find((template) => template.id === target.id)
    if (!template) return null
    return target.itemId ? shorten(findItem(template.items, target.itemId)?.text) || null : shorten(template.name) || null
  }
  if (target.kind === 'list') {
    const list = state.lists.find((list) => list.id === target.id)
    if (!list) return null
    if (target.itemId) return shorten(findItem(list.items, target.itemId)?.text) || null
    return shorten(state.listTemplates.find((template) => template.id === list.listTemplateId)?.name) || null
  }
  if (target.kind === 'quiz') {
    const metric = state.metrics.find((metric) => metric.id === target.id)
    if (!metric) return null
    return target.itemId ? shorten(metric.questions.find((question) => question.id === target.itemId)?.prompt) || null : shorten(metric.name) || null
  }
  if (target.kind === 'goal') return shorten(state.goals.find((goal) => goal.id === target.id)?.name) || null
  if (target.kind === 'idea-group') return IDEA_GROUPS.find((group) => group.kind === target.id)?.label ?? null
  return 'Prioritize'
}

// Pasting a lone balance:// link inserts it titled, as if the title had been
// selected and linked by hand.
export function pastedBalanceLinkHTML(clipboardText: string, state: LinkTitleState): string | null {
  const url = clipboardText.trim()
  if (!url.startsWith('balance://') || /\s/.test(url)) return null
  const title = balanceLinkTitle(url, state)
  return title ? `<a href="${escapeHTML(url)}">${escapeHTML(title)}</a>` : null
}
