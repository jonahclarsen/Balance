export const BUCKET_REVIEW_LABELS = {
  genuine: 'Review Genuinely Worth Doing',
  possible: 'Review Possibly Worth Doing',
  afterlife: 'Review Idea Afterlife',
} as const

export type BucketReviewKind = keyof typeof BUCKET_REVIEW_LABELS

export function bucketsLinkFromURL(value: string): 'page' | BucketReviewKind | null {
  const match = /^balance:\/\/buckets(?:\/review(?:\/(genuine|possible|afterlife))?)?$/.exec(value.trim())
  if (!match) return null
  if (value.trim() === 'balance://buckets') return 'page'
  // Existing goal and task links continue to review Genuinely Worth Doing.
  return (match[1] as BucketReviewKind | undefined) ?? 'genuine'
}
