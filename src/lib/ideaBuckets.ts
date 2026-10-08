import { createPlanItem, escapeHTML, htmlToPlainText, sanitizeInlineHTML } from './planner'
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

const BLOCK_SELECTOR = 'ul, ol, p, div, blockquote, h1, h2, h3, h4, h5, h6, section, article, li, table, tr, td, th, pre'

function ideaFromHTML(html: string, children: PlanItem[] = []): PlanItem | null {
  const sanitized = sanitizeInlineHTML(html).replace(/^(?:<br>|\s)+|(?:<br>|\s)+$/g, '')
  const text = htmlToPlainText(sanitized).trim()
  if (!text && children.length === 0) return null
  return { ...createPlanItem(text || ''), html: text ? sanitized : '', children }
}

// Every <br>-separated line of a leaf block is its own idea.
function ideasFromLeaf(element: Element): PlanItem[] {
  return element.innerHTML.split(/<br\s*\/?>/i).flatMap((line) => {
    const idea = ideaFromHTML(line)
    return idea ? [idea] : []
  })
}

function ideasFromList(list: Element): PlanItem[] {
  return Array.from(list.children).filter((child) => child.matches('li')).flatMap((li) => {
    const inline = li.cloneNode(true) as HTMLElement
    const nested = Array.from(inline.children).filter((child) => child.matches('ul, ol'))
    nested.forEach((child) => child.remove())
    const children = Array.from(li.children).filter((child) => child.matches('ul, ol')).flatMap(ideasFromList)
    // A bullet with its own block children (Notesnook wraps bullet text in <p>).
    const blocks = Array.from(inline.children).filter((child) => child.matches(BLOCK_SELECTOR))
    const lines = blocks.length > 0 ? blocks.flatMap((block) => ideasFromContainer(block)) : ideasFromLeaf(inline)
    if (lines.length === 0) return children
    const [first, ...rest] = lines
    return [{ ...first!, children: [...first!.children, ...children] }, ...rest]
  })
}

function ideasFromContainer(element: Element): PlanItem[] {
  if (element.matches('ul, ol')) return ideasFromList(element)
  const blocks = Array.from(element.children).filter((child) => child.matches(BLOCK_SELECTOR))
  if (blocks.length === 0) return ideasFromLeaf(element)
  // Text nodes and inline runs between blocks still count as lines.
  const ideas: PlanItem[] = []
  let inline = ''
  const flush = () => {
    if (inline.trim()) {
      const holder = document.createElement('div')
      holder.innerHTML = inline
      ideas.push(...ideasFromLeaf(holder))
    }
    inline = ''
  }
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === Node.ELEMENT_NODE && (node as Element).matches(BLOCK_SELECTOR)) {
      flush()
      ideas.push(...ideasFromContainer(node as Element))
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      inline += (node as Element).outerHTML
    } else if (node.nodeType === Node.TEXT_NODE) {
      inline += escapeHTML(node.textContent ?? '')
    }
  }
  flush()
  return ideas
}

export function parseIdeaImportHTML(html: string): PlanItem[] {
  if (!html.trim() || typeof DOMParser === 'undefined') return []
  const parsed = new DOMParser().parseFromString(html, 'text/html')
  return ideasFromContainer(parsed.body)
}

const BULLET_LINE = /^([ \t]*)(?:(?:[-*+•◦▪‣]|\d+[.)]|[☐☑✓✔])[ \t]+)?(.*)$/

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

// HTML wins when it yields anything; otherwise fall back to the plain lines.
export function parseIdeaImport(html: string, text: string): PlanItem[] {
  const fromHTML = parseIdeaImportHTML(html)
  return fromHTML.length > 0 ? fromHTML : parseIdeaImportText(text)
}

export function countIdeas(items: PlanItem[]): number {
  return items.reduce((total, item) => total + 1 + countIdeas(item.children), 0)
}
