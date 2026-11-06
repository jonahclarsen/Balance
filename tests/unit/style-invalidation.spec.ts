import { expect, test } from '@playwright/test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = new URL('../../src', import.meta.url).pathname

function styleSources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return styleSources(path)
    return /\.(css|svelte)$/.test(entry.name) ? [path] : []
  })
}

// Chromium re-checks a :has() on the document root or body whenever an
// element is added or removed, and when it may have changed it restyles every
// element. A body:has(.document-find) rule made every dialog open and close
// restyle all of Balance and block a phone for up to half a second. Toggle a
// class on the root instead.
test('no :has() rules on the document root or body', () => {
  const rootHas = /(?:^|[\s,(])(?:html|body|:root)(?:\[[^\]]*\]|:(?!has\()[\w-]+(?:\([^)]*\))?)*:has\(/m
  const offenders = styleSources(src).flatMap(file =>
    readFileSync(file, 'utf8').split('\n').flatMap((line, index) =>
      rootHas.test(line) ? [`${file.slice(src.length + 1)}:${index + 1}: ${line.trim()}`] : []))
  expect(offenders).toEqual([])
})
