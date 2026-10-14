// Appends a content hash to every /images/*.webp reference in the site's HTML
// and CSS. Recaptured screenshots keep their filenames, so without a changed
// URL browsers keep showing the old pictures.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const root = new URL('../public/', import.meta.url).pathname
const versions = new Map()

function version(name) {
  if (!versions.has(name)) {
    const bytes = readFileSync(join(root, 'images', name))
    versions.set(name, createHash('sha256').update(bytes).digest('hex').slice(0, 10))
  }
  return versions.get(name)
}

function* pages(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* pages(path)
    else if (/\.(html|css)$/.test(entry.name)) yield path
  }
}

for (const path of pages(root)) {
  const before = readFileSync(path, 'utf8')
  const after = before.replace(
    /\/images\/([a-z0-9-]+\.webp)(\?v=[0-9a-f]+)?/g,
    (_, name) => `/images/${name}?v=${version(name)}`,
  )
  if (after !== before) writeFileSync(path, after)
}
