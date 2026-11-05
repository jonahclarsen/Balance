import { parseNoteBlocksFromClipboard, type ParsedNoteClipboardItem } from './noteClipboard'
import { shiftISODate } from './goals'
import { createPlanItem, escapeHTML, htmlToPlainText, linkifyExternalURLs, sanitizeInlineHTML, todayISO } from './planner'
import { parseTaskClipboardAsNoteBlocks } from './taskClipboard'
import type { Id, IdeaGroup, IdeaGroupKind, IdeaItem, PlanItem } from './types'

export type IdeaGroupMeta = { kind: IdeaGroupKind; id: Id; label: string; key: string }

// Display order. `key` is the plain letter that moves a selected idea here.
export const IDEA_GROUPS: readonly IdeaGroupMeta[] = [
  { kind: 'proposition', id: 'bucket_proposition', label: 'Proposition Party', key: 'u' },
  { kind: 'genuine', id: 'bucket_genuine', label: 'Genuinely Worth Doing', key: 'g' },
  { kind: 'possible', id: 'bucket_possible', label: 'Possibly Worth Doing', key: 'p' },
  { kind: 'afterlife', id: 'bucket_afterlife', label: 'Idea Afterlife', key: 'a' },
  { kind: 'trash', id: 'bucket_trash', label: 'Trash', key: 't' },
] as const

export const IDEA_GROUP_KINDS = IDEA_GROUPS.map((group) => group.kind)

export function ideaGroupMeta(kind: IdeaGroupKind): IdeaGroupMeta {
  return IDEA_GROUPS.find((group) => group.kind === kind)!
}

export function ideaGroupId(kind: IdeaGroupKind): Id {
  return ideaGroupMeta(kind).id
}

export function ideaGroupKindForKey(key: string): IdeaGroupKind | null {
  return IDEA_GROUPS.find((group) => group.key === key.toLowerCase())?.kind ?? null
}

const ACTIVE_IDEA_GROUP_KEY = 'balance.activeIdeaGroup.v1'

// Which group the Ideas page shows is per device, like the selected day template.
export function readActiveIdeaGroup(): IdeaGroupKind {
  try {
    const stored = localStorage.getItem(ACTIVE_IDEA_GROUP_KEY)
    return IDEA_GROUPS.find((group) => group.kind === stored)?.kind ?? 'proposition'
  } catch {
    return 'proposition'
  }
}

export function saveActiveIdeaGroup(kind: IdeaGroupKind) {
  try {
    localStorage.setItem(ACTIVE_IDEA_GROUP_KEY, kind)
  } catch {
    // The choice just won't outlast this session.
  }
}

// Committing an idea takes progressively longer the higher it lands, so the
// buttons unlock on a delay instead of being explained. The Ideas page applies
// it only to ideas leaving Proposition Party; the sorter applies it after every answer.
export const IDEA_UNLOCK_MS: Record<IdeaGroupKind, number> = {
  proposition: 0,
  trash: 0,
  afterlife: 1000,
  possible: 2000,
  genuine: 3000,
}

export function ideaUnlockDelay(from: IdeaGroupKind | null, to: IdeaGroupKind): number {
  return from === 'proposition' ? IDEA_UNLOCK_MS[to] : 0
}

export const IDEA_TRASH_RETENTION_DAYS = 30
export const IDEA_TRASH_RETENTION_MS = IDEA_TRASH_RETENTION_DAYS * 24 * 60 * 60 * 1000

export function ideaTrashExpiresAt(item: IdeaItem): number | null {
  if (!item.bucketedAt) return null
  const bucketedAt = Date.parse(item.bucketedAt)
  return Number.isFinite(bucketedAt) ? bucketedAt + IDEA_TRASH_RETENTION_MS : null
}

export function isIdeaTrashExpired(item: IdeaItem, now = Date.now()): boolean {
  const expiresAt = ideaTrashExpiresAt(item)
  return expiresAt !== null && expiresAt <= now
}

export function ideaGroupItems(groups: IdeaGroup[], kind: IdeaGroupKind): IdeaItem[] {
  return groups.find((group) => group.kind === kind)?.items ?? []
}

export function findIdea(groups: IdeaGroup[], itemId: Id): { group: IdeaGroup; item: IdeaItem; index: number } | null {
  for (const group of groups) {
    const index = group.items.findIndex((item) => item.id === itemId)
    if (index !== -1) return { group, item: group.items[index]!, index }
  }
  return null
}

export const IDEA_SORT_QUESTION = 'Is this worth the time and attention it would cost, compared to other uses of that time?'

// ---- Scheduled reviews ---------------------------------------------------

export type ScheduledIdeaReviewKind = 'genuine' | 'possible'
export const IDEA_REVIEW_SCHEDULE: readonly { kind: ScheduledIdeaReviewKind; days: number }[] = [
  { kind: 'genuine', days: 10 },
  { kind: 'possible', days: 45 },
]
export const IDEA_REVIEW_MAX_DAYS = 365

export function scheduledIdeaReviewDefault(kind: IdeaGroupKind): number | null {
  return IDEA_REVIEW_SCHEDULE.find((schedule) => schedule.kind === kind)?.days ?? null
}

// Whole days from 1 to a year, or null for anything else.
export function parseIdeaReviewDays(value: unknown): number | null {
  const days = typeof value === 'number' ? value : Number(String(value).trim())
  return Number.isInteger(days) && days >= 1 && days <= IDEA_REVIEW_MAX_DAYS ? days : null
}

export function ideaReviewDays(groups: IdeaGroup[], kind: ScheduledIdeaReviewKind): number {
  const stored = groups.find((group) => group.kind === kind)?.reviewDays
  return parseIdeaReviewDays(stored) ?? scheduledIdeaReviewDefault(kind)!
}

export type DueIdeaReview = { kind: ScheduledIdeaReviewKind; days: number; items: IdeaItem[] }

function bucketedDay(item: IdeaItem): string {
  const time = item.bucketedAt ? Date.parse(item.bucketedAt) : NaN
  return Number.isFinite(time) ? todayISO(new Date(time)) : ''
}

// Every sort decision restamps bucketedAt, so a group's oldest stamp marks its
// last review. A review is due that many days later and covers every idea
// placed before the due day; ideas sorted in since then wait for the next one.
export function dueIdeaReviews(groups: IdeaGroup[], today = todayISO()): DueIdeaReview[] {
  return IDEA_REVIEW_SCHEDULE.flatMap(({ kind }) => {
    const days = ideaReviewDays(groups, kind)
    const items = ideaGroupItems(groups, kind)
    if (items.length === 0) return []
    const stampDays = items.map(bucketedDay)
    const oldest = [...stampDays].sort()[0]!
    const dueDay = oldest ? shiftISODate(oldest, days) : today
    if (today < dueDay) return []
    return [{ kind, days, items: items.filter((_, index) => stampDays[index]! < dueDay) }]
  })
}

// ---- Import ----------------------------------------------------------------

// Imports share the notes paste parser (Balance task blocks, Apple Notes,
// Notesnook, checklists, plain lines) so improvements there carry over.
function ideasFromNoteBlocks(blocks: ParsedNoteClipboardItem[]): PlanItem[] {
  return blocks.flatMap((block) => {
    const children = ideasFromNoteBlocks(block.children)
    // A paragraph with hard line breaks is several ideas; list items keep theirs.
    const lines = block.kind === 'bullet' || block.kind === 'numbered' || block.kind === 'checklist'
      ? [block.html]
      : block.html.split(/<br\s*\/?>/i)
    const ideas = lines.flatMap((line) => {
      const html = sanitizeInlineHTML(line).replace(/^(?:<br>|\s)+|(?:<br>|\s)+$/g, '')
      const text = htmlToPlainText(html).trim()
      return text ? [{ ...createPlanItem(text), html, done: block.done }] : []
    })
    if (ideas.length === 0) return children
    const [first, ...rest] = ideas
    return [{ ...first!, children }, ...rest]
  })
}

const BULLET_LINE = /^([ \t]*)(?:(?:[-*+•◦▪‣]|\d+[.)]|[☐☑✓✔])[ \t]+)?(.*)$/

// Typed or plain-text lists: markers are stripped and indentation nests.
export function parseIdeaImportText(text: string): PlanItem[] {
  const roots: PlanItem[] = []
  const ancestors: { indent: number; item: PlanItem }[] = []
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const match = BULLET_LINE.exec(raw)!
    const content = match[2]!.trim()
    if (!content) continue
    const indent = match[1]!.replace(/\t/g, '  ').length
    const html = linkifyExternalURLs(escapeHTML(content))
    const item = { ...createPlanItem(content), ...(html.includes('<a ') ? { html } : {}) }
    while (ancestors.length && ancestors.at(-1)!.indent >= indent) ancestors.pop()
    const parent = ancestors.at(-1)?.item
    ;(parent ? parent.children : roots).push(item)
    ancestors.push({ indent, item })
  }
  return roots
}

// Balance task blocks and rich HTML go through the shared notes parser; bare
// text keeps the bullet-aware line parser.
export function parseIdeaImport(html: string, text: string): PlanItem[] {
  const fromTasks = parseTaskClipboardAsNoteBlocks(text)
  if (fromTasks) return ideasFromNoteBlocks(fromTasks)
  if (html.trim()) {
    const fromNotes = ideasFromNoteBlocks(parseNoteBlocksFromClipboard(text, html))
    if (fromNotes.length > 0) return fromNotes
  }
  return parseIdeaImportText(text)
}

export function countIdeas(items: PlanItem[]): number {
  return items.reduce((total, item) => total + 1 + countIdeas(item.children), 0)
}
