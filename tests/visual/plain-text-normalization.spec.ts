import { expect, test } from '@playwright/test'

test('plain task hydration agrees with browser parsing for generated text', async ({ page }) => {
  await page.goto('/')
  const differences = await page.evaluate(async () => {
    const load = new Function('return import("/src/lib/planner.ts")') as () => Promise<{ sanitizeInlineHTML: (value: string) => string }>
    const { sanitizeInlineHTML } = await load()
    const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;')
    const values = ['', 'plain', 'trailing\n\n', '  \n', '\r\n', '\u0000', 'a\u0000b', '\uD800', 'x\uDFFF', '"quoted" > \'apostrophe\'', 'caf\u00e9 \uD83C\uDF3F', 'a &amp; b', '&lt;script&gt;']
    let seed = 0x4162
    const chars = ['a', '>', '"', "'", '\n', '\r', '\u0000', '\t', ' ', '\u00a0', '\uD800', '\uDC00', '\u2028', '\u00e9', '\uD83C\uDF3F', '&amp;', '&#13;', '&#10;', '&unknown;']
    for (let index = 0; index < 500; index++) {
      let value = ''
      for (let char = 0; char < index % 30; char++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        value += chars[seed % chars.length]
      }
      values.push(value)
    }
    return values.flatMap(value => {
      // An independent browser parse is the oracle for input normalization and
      // entity decoding. These inputs contain no elements; sanitation escapes
      // their parsed text and removes raw trailing newlines.
      const template = document.createElement('template')
      template.innerHTML = value
      const sanitized = escape(template.content.textContent ?? '')
      const cleanup = document.createElement('template')
      cleanup.innerHTML = sanitized
      const parsed = cleanup.content.textContent ?? ''
      const stripped = parsed.replace(/\n+$/, '')
      const expected = stripped === parsed ? sanitized : escape(stripped)
      const actual = sanitizeInlineHTML(value)
      return actual === expected ? [] : [{ value, expected, actual }]
    })
  })
  expect(differences).toEqual([])
})
