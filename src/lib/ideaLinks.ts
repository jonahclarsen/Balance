export const IDEA_REVIEW_LABELS = {
  genuine: 'Review Genuinely Worth Doing',
  possible: 'Review Possibly Worth Doing',
  afterlife: 'Review Idea Afterlife',
} as const

export type IdeaReviewKind = keyof typeof IDEA_REVIEW_LABELS

// Saved notes, tasks and the seeded review goal still hold balance://buckets links.
export function ideasLinkFromURL(value: string): 'page' | IdeaReviewKind | null {
  const match = /^balance:\/\/(?:ideas|buckets)(\/review(?:\/(genuine|possible|afterlife))?)?$/.exec(value.trim())
  if (!match) return null
  if (!match[1]) return 'page'
  // Existing goal and task links continue to review Genuinely Worth Doing.
  return (match[2] as IdeaReviewKind | undefined) ?? 'genuine'
}
