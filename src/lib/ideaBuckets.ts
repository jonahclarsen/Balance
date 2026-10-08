import { parseNoteBlocksFromClipboard, type ParsedNoteClipboardItem } from './noteClipboard'
import { createPlanItem, escapeHTML, htmlToPlainText, sanitizeInlineHTML } from './planner'
import { parseTaskClipboardAsNoteBlocks } from './taskClipboard'
import type { Goal, Id, IdeaBucket, IdeaBucketKind, IdeaItem, PlanItem } from './types'

export type IdeaBucketMeta = { kind: IdeaBucketKind; id: Id; label: string; key: string }

// Display order. `key` is the plain letter that moves a selected idea here.
export const IDEA_BUCKETS: readonly IdeaBucketMeta[] = [
  { kind: 'proposition', id: 'bucket_proposition', label: 'Proposition Party', key: 'u' },
  { kind: 'genuine', id: 'bucket_genuine', label: 'Genuinely Worth Doing', key: 'g' },
  { kind: 'possible', id: 'bucket_possible', label: 'Possibly Worth Doing', key: 'p' },
  { kind: 'afterlife', id: 'bucket_afterlife', label: 'Idea Afterlife', key: 'a' },
  { kind: 'trash', id: 'bucket_trash', label: 'Trash', key: 't' },
] as const

export const IDEA_BUCKET_KINDS = IDEA_BUCKETS.map((bucket) => bucket.kind)

export function ideaBucketMeta(kind: IdeaBucketKind): IdeaBucketMeta {
  return IDEA_BUCKETS.find((bucket) => bucket.kind === kind)!
}

export function ideaBucketId(kind: IdeaBucketKind): Id {
  return ideaBucketMeta(kind).id
}

export function ideaBucketKindForKey(key: string): IdeaBucketKind | null {
  return IDEA_BUCKETS.find((bucket) => bucket.key === key.toLowerCase())?.kind ?? null
}

// Leaving Proposition Party takes progressively longer the higher the idea
// lands, so the commitment buttons unlock on a delay instead of being explained.
export const BUCKET_UNLOCK_MS: Record<IdeaBucketKind, number> = {
  proposition: 0,
  trash: 0,
  afterlife: 1000,
  possible: 2000,
  genuine: 3000,
}

export function bucketUnlockDelay(from: IdeaBucketKind | null, to: IdeaBucketKind): number {
  return from === 'proposition' ? BUCKET_UNLOCK_MS[to] : 0
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

export function bucketItems(buckets: IdeaBucket[], kind: IdeaBucketKind): IdeaItem[] {
  return buckets.find((bucket) => bucket.kind === kind)?.items ?? []
}

export function findIdea(buckets: IdeaBucket[], itemId: Id): { bucket: IdeaBucket; item: IdeaItem; index: number } | null {
  for (const bucket of buckets) {
    const index = bucket.items.findIndex((item) => item.id === itemId)
    if (index !== -1) return { bucket, item: bucket.items[index]!, index }
  }
  return null
}

export const IDEA_SORT_QUESTION = 'Is this worth the time and attention it would cost, compared to other uses of that time?'

// ---- Review goal -----------------------------------------------------------

export const BUCKETS_URL = 'balance://buckets'
export const IDEA_REVIEW_URL = 'balance://buckets/review'
export const IDEA_REVIEW_GOAL_ID = 'goal_idea_review'
export const IDEA_REVIEW_GOAL_NAME = 'Filter Genuinely Worth Doing'
export const IDEA_REVIEW_GOAL_CADENCE_DAYS = 7

// Returns true when the review goal still has to be seeded into this database.
export function needsIdeaReviewGoal(goals: Pick<Goal, 'id'>[]): boolean {
  return !goals.some((goal) => goal.id === IDEA_REVIEW_GOAL_ID)
}

export function ideaReviewGoalNameHtml(): string {
  return `<a href="${IDEA_REVIEW_URL}">${escapeHTML(IDEA_REVIEW_GOAL_NAME)}</a>`
}

// A hue far from the ones already in use, so the seeded goal stands apart.
export function ideaReviewGoalHue(goals: Pick<Goal, 'hue'>[]): number {
  const candidates = [275, 35, 155, 215, 335, 95]
  const used = goals.map((goal) => goal.hue)
  const distance = (hue: number) => Math.min(360, ...used.map((other) => Math.min(Math.abs(hue - other), 360 - Math.abs(hue - other))))
  return candidates.reduce((best, hue) => distance(hue) > distance(best) ? hue : best, candidates[0]!)
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
    const item = createPlanItem(content)
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
