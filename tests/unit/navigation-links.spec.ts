import { expect, test } from '@playwright/test'
import { LINKABLE_VIEWS, navigationURL, parseNavigationURL } from '../../src/lib/navigationLinks'
import { internalLinkId, itemLinkFromURL, linkifyItemText, resolveItemLinks } from '../../src/lib/planner'
import { IDEA_REVIEW_LABELS, ideasLinkFromURL } from '../../src/lib/ideaLinks'

test('group review links preserve the selected group in plain text and internal anchors', () => {
  for (const kind of ['genuine', 'possible', 'afterlife'] as const) {
    const url = `balance://ideas/review/${kind}`
    const link = { kind: 'ideas', review: kind, label: IDEA_REVIEW_LABELS[kind] } as const
    expect(ideasLinkFromURL(url)).toBe(kind)
    expect(itemLinkFromURL(url)).toEqual(link)
    expect(resolveItemLinks(`Review (${url}).`, [], [])).toEqual([link])
    expect(linkifyItemText(url, [], [])).toEqual([{ text: url, link }])
    expect(itemLinkFromURL(`balance://ideas/${internalLinkId(link)}`)).toEqual(link)
  }
  expect(itemLinkFromURL('balance://ideas/review')).toEqual(itemLinkFromURL('balance://ideas/review/genuine'))
  expect(itemLinkFromURL('balance://ideas')).toEqual({ kind: 'ideas', review: null, label: 'Ideas' })
  for (const suffix of ['trash', 'proposition', 'unknown', 'possible/more', 'possible?other=1', 'afterlife#more']) {
    expect(itemLinkFromURL(`balance://ideas/review/${suffix}`)).toBeNull()
  }
})

test('links saved while Ideas was called Buckets still open it', () => {
  expect(itemLinkFromURL('balance://buckets')).toEqual(itemLinkFromURL('balance://ideas'))
  expect(itemLinkFromURL('balance://buckets/review')).toEqual(itemLinkFromURL('balance://ideas/review/genuine'))
  expect(itemLinkFromURL('balance://buckets/review/possible')).toEqual(itemLinkFromURL('balance://ideas/review/possible'))
  expect(parseNavigationURL('balance://page/buckets')).toEqual({ kind: 'page', view: 'ideas' })
  expect(parseNavigationURL('balance://bucket/trash')).toEqual({ kind: 'idea-group', id: 'trash' })
})

test('navigation routes round trip dates, page names and generated row IDs', () => {
  for (const view of LINKABLE_VIEWS) expect(parseNavigationURL(navigationURL('page', view))).toEqual({ kind: 'page', view })
  expect(parseNavigationURL(navigationURL('quiz', 'quiz_id', 'question_id', '2026-10-20'))).toEqual({ kind: 'quiz', id: 'quiz_id', itemId: 'question_id', date: '2026-10-20' })
  expect(parseNavigationURL('balance://day/2028-02-29')).toEqual({ kind: 'day', date: '2028-02-29' })
  for (const kind of ['day-template', 'list-template', 'note', 'list', 'quiz', 'prioritize'] as const) {
    expect(parseNavigationURL(navigationURL(kind, 'synthetic_id', 'row_123.generated-456'))).toEqual({ kind, id: 'synthetic_id', itemId: 'row_123.generated-456' })
  }
  for (const kind of ['task', 'goal', 'idea-group'] as const) expect(parseNavigationURL(navigationURL(kind, 'synthetic_id'))).toEqual({ kind, id: 'synthetic_id' })
})

test('malformed navigation URLs cannot navigate to an accepted prefix', () => {
  for (const url of ['balance://page/unknown', 'balance://day/2026-02-29', 'balance://day/2026-13-01', 'balance://task/a/more', 'balance://task/a#more', 'balance://task/a?other=1', 'balance://note/a?item=', 'balance://note/a?item=b&item=c', 'balance://user@task/a', 'balance://task:99/a', 'balance://task/a/', 'balance://task/../a', 'balance://task/%2Fa', 'https://task/a', 'balance://quiz/q?date=2026-02-29', 'balance://note/n?date=2026-10-20']) {
    expect(parseNavigationURL(url), url).toBeNull()
  }
})

test('plain text and rich text use the same navigation destinations', () => {
  for (const url of ['balance://task/list_item_123.generated-456', 'balance://note/n?item=p', 'balance://page/settings', 'balance://day/2026-10-20', 'balance://quiz/q?item=question', 'balance://prioritize/s?item=row']) {
    const link = itemLinkFromURL(url)!
    expect(link).not.toBeNull()
    expect(internalLinkId(link)).toBe(url)
    expect(resolveItemLinks(`See (${url}), please.`, [], [])).toEqual([link])
    expect(linkifyItemText(`See (${url}), please.`, [], [])).toEqual([
      { text: 'See (', link: null }, { text: url, link }, { text: '), please.', link: null },
    ])
  }
  for (const invalid of ['balance://note/n/other', 'balance://projects/p?bad=1', 'balance://review/day/id/other']) expect(resolveItemLinks(invalid, [], [])).toEqual([])
})
