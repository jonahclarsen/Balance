// Synthetic notes used by the editor conformance suite. Entirely fabricated;
// never derived from a real database. Ids are deterministic so tests can
// assert byte-identical round trips.

import type { Note, NoteItem, NoteItemKind } from '../../src/lib/types'

let counter = 0
function id(prefix = 'note_item'): string {
  counter += 1
  return `${prefix}_${String(counter).padStart(4, '0')}`
}

function textFromHTML(html: string): string {
  // Mirrors htmlToPlainText: a <br> contributes no character to `text`.
  return html
    .replace(/<br\s*\/?>/g, '')
    .replace(/<[^>]+>/g, '')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#039;', "'")
}

type ItemSpec = {
  kind?: NoteItemKind
  html: string
  done?: boolean
  children?: ItemSpec[]
  // Fields a newer client might have added; the editors must carry them.
  extra?: Record<string, unknown>
}

export function item(spec: ItemSpec): NoteItem {
  const base: NoteItem = {
    id: id(),
    kind: spec.kind ?? 'paragraph',
    text: textFromHTML(spec.html),
    html: spec.html,
    done: spec.done ?? false,
    startMinutes: null,
    endMinutes: null,
    children: (spec.children ?? []).map(item),
  }
  return spec.extra ? ({ ...base, ...spec.extra } as NoteItem) : base
}

function note(title: string, items: NoteItem[], index: number): Note {
  const stamp = new Date(Date.UTC(2026, 0, 1 + index, 9, 0, 0)).toISOString()
  return { id: id('note'), title, items, createdAt: stamp, updatedAt: stamp, deletedAt: null }
}

export function createNotesCorpus(): Note[] {
  counter = 0
  const notes: Note[] = []

  notes.push(note('Simple paragraphs', [
    item({ html: 'First paragraph with plain text.' }),
    item({ html: 'Second paragraph with <strong>bold</strong>, <em>italic</em>, and <u>underlined</u> runs.' }),
    item({ html: 'Nested <strong>bold <em>and italic</em></strong> plus a line<br>break inside one block.' }),
    item({ html: '' }),
    item({ html: 'Paragraph after an empty one, with &lt;angle&gt; brackets &amp; ampersands &quot;quoted&quot; &#039;single&#039;.' }),
  ], notes.length))

  notes.push(note('Headings and quotes', [
    item({ kind: 'heading', html: 'Project kickoff' }),
    item({ html: 'A paragraph under the heading.' }),
    item({ kind: 'quote', html: 'The best time to plant a tree was twenty years ago.' }),
    item({ kind: 'quote', html: 'Second quote with <em>emphasis</em>.' }),
    item({ kind: 'heading', html: 'Another <strong>bold</strong> heading' }),
    item({ html: 'Closing thoughts.' }),
  ], notes.length))

  notes.push(note('Nested lists', [
    item({ kind: 'bullet', html: 'Groceries', children: [
      item({ kind: 'bullet', html: 'Apples' }),
      item({ kind: 'bullet', html: 'Bread', children: [
        item({ kind: 'bullet', html: 'Sourdough' }),
        item({ kind: 'bullet', html: 'Rye' }),
      ] }),
    ] }),
    item({ kind: 'bullet', html: 'Errands' }),
    item({ kind: 'numbered', html: 'Step one', children: [
      item({ kind: 'numbered', html: 'Sub-step a' }),
      item({ kind: 'numbered', html: 'Sub-step b' }),
    ] }),
    item({ kind: 'numbered', html: 'Step two' }),
    item({ kind: 'numbered', html: 'Step three' }),
    item({ html: 'Paragraph between lists.' }),
    item({ kind: 'numbered', html: 'A new numbered list starts at one again.' }),
  ], notes.length))

  notes.push(note('Checklist', [
    item({ kind: 'checklist', html: 'Done item', done: true }),
    item({ kind: 'checklist', html: 'Open item' }),
    item({ kind: 'checklist', html: 'Parent with children', children: [
      item({ kind: 'checklist', html: 'Child one', done: true }),
      item({ kind: 'checklist', html: 'Child two' }),
      item({ kind: 'bullet', html: 'A bullet child under a checklist' }),
    ] }),
    item({ kind: 'checklist', html: 'All children done', done: true, children: [
      item({ kind: 'checklist', html: 'Sub A', done: true }),
      item({ kind: 'checklist', html: 'Sub B', done: true }),
    ] }),
    item({ kind: 'paragraph', html: 'Trailing paragraph.' }),
  ], notes.length))

  notes.push(note('Links', [
    item({ html: 'External: <a href="https://example.com/path?q=1&amp;r=2" target="_blank" rel="noreferrer">example.com</a> and text after.' }),
    item({ html: '<a href="https://example.org" target="_blank" rel="noreferrer"><strong>Bold link</strong></a> at the start.' }),
    item({ html: 'Goal stats link: <a href="balance://goals/stats">stats</a>.' }),
    item({ html: 'Two links: <a href="https://a.example" target="_blank" rel="noreferrer">A</a> <a href="https://b.example" target="_blank" rel="noreferrer">B</a>' }),
  ], notes.length))

  notes.push(note('Unicode 🌍 日本語', [
    item({ kind: 'heading', html: 'Emoji 🎉🚀 and CJK 日本語のテキスト' }),
    item({ html: '한국어 문장입니다. 中文句子。日本語の文章です。' }),
    item({ html: 'Combining marks: é and ZWJ family 👨‍👩‍👧‍👦 and flags 🇯🇵🇺🇸' }),
    item({ kind: 'bullet', html: 'Right-to-left: مرحبا بالعالم' }),
    item({ kind: 'bullet', html: 'Math: ∑ x² + ∫ f(x) dx ≈ π' }),
    item({ html: 'Tabs\tand   multiple   spaces and a trailing space ' }),
  ], notes.length))

  notes.push(note('Mixed kinds nesting', [
    item({ kind: 'heading', html: 'Plan' }),
    item({ kind: 'bullet', html: 'Bullet with a numbered child list', children: [
      item({ kind: 'numbered', html: 'One' }),
      item({ kind: 'numbered', html: 'Two', children: [
        item({ kind: 'checklist', html: 'Deep checklist' }),
        item({ kind: 'quote', html: 'Deep quote' }),
        item({ kind: 'paragraph', html: 'Deep paragraph' }),
      ] }),
    ] }),
    item({ kind: 'paragraph', html: 'Paragraph with children', children: [
      item({ kind: 'paragraph', html: 'Child paragraph' }),
    ] }),
    item({ kind: 'quote', html: 'Quote with a child', children: [
      item({ kind: 'bullet', html: 'Bullet under quote' }),
    ] }),
  ], notes.length))

  notes.push(note('Unknown fields from a newer client', [
    item({ html: 'Item with extra fields', extra: { futureFlag: true, futureMeta: { a: 1, b: [1, 2] } } }),
    item({ kind: 'checklist', html: 'Checklist with reminder', extra: { reminderAt: '2027-01-01T00:00:00.000Z' } }),
    item({ kind: 'bullet', html: 'Bullet with generatedGoalId', extra: { generatedGoalId: 'goal_0001', timeHidden: true } }),
  ], notes.length))

  notes.push(note('Messy pasted HTML (already sanitized on save)', [
    item({ html: 'Text with <strong>bold</strong> that came from a <em>web page</em>.' }),
    item({ html: 'Line one<br>Line two<br>Line three' }),
    item({ html: '<strong></strong>Empty formatting wrappers are gone but text stays.' }),
    item({ html: 'A very long word: ' + 'supercalifragilistic'.repeat(8) }),
  ], notes.length))

  const longItems: NoteItem[] = []
  for (let section = 0; section < 12; section += 1) {
    longItems.push(item({ kind: 'heading', html: `Section ${section + 1}` }))
    for (let paragraph = 0; paragraph < 8; paragraph += 1) {
      longItems.push(item({ html: `Paragraph ${section + 1}.${paragraph + 1}: ${'Lorem ipsum dolor sit amet, consectetur adipiscing elit. '.repeat(3)}` }))
    }
    longItems.push(item({ kind: 'bullet', html: `List for section ${section + 1}`, children: Array.from({ length: 6 }, (_, index) =>
      item({ kind: 'bullet', html: `Point ${index + 1}` })) }))
    longItems.push(item({ kind: 'checklist', html: `Task ${section + 1}`, done: section % 2 === 0 }))
  }
  notes.push(note('Long note', longItems, notes.length))

  notes.push(note('Empty note', [], notes.length))
  notes.push(note('', [item({ html: 'Untitled note body' })], notes.length))

  notes.push(note('Binned note', [item({ html: 'This note is in the bin.' })], notes.length))
  const binned = notes[notes.length - 1]
  // Recently binned: the app purges Bin notes older than 30 days at startup.
  binned.deletedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString()

  return notes
}

export function corpusItemCount(notes: Note[]): number {
  const count = (items: NoteItem[]): number => items.reduce((sum, entry) => sum + 1 + count(entry.children), 0)
  return notes.reduce((sum, entry) => sum + count(entry.items), 0)
}
