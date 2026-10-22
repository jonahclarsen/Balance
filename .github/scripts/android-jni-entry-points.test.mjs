import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ENTRY_POINTS } from './android-jni-entry-points.mjs'

async function files(directory, extension) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true })
  return entries.filter(entry => entry.isFile() && entry.name.endsWith(extension)).map(entry => join(entry.parentPath, entry.name))
}

test('every Kotlin method Rust calls through a bridged class is a listed entry point', async () => {
  const listed = new Set(Object.values(ENTRY_POINTS).flat())
  for (const file of await files('src-tauri/src', '.rs')) {
    const source = await readFile(file, 'utf8')
    // Framework classes are named by string literal; Balance's arrive as a class reference.
    for (const [, owner, name] of source.matchAll(/call_static_method\(\s*([^,]+?),\s*"(\w+)"/g)) {
      if (owner.startsWith('"') && !owner.startsWith('"app/balance/')) continue
      assert.ok(listed.has(name), `${file} calls ${name} through JNI; add it to ENTRY_POINTS and mark it @Keep`)
    }
  }
})

test('every JNI entry point is kept through R8', async () => {
  const sources = await Promise.all([...await files('.github/android', '.kt'), ...await files('src-tauri/android', '.kt')].map(file => readFile(file, 'utf8')))
  for (const [owner, names] of Object.entries(ENTRY_POINTS)) {
    const simple = owner.split('.').at(-1)
    const source = sources.find(text => new RegExp(`^(object|class) ${simple}\\b`, 'm').test(text))
    assert.ok(source, `No Kotlin source declares ${owner}`)
    for (const name of names) {
      assert.match(source, new RegExp(`@androidx\\.annotation\\.Keep\\s+@JvmStatic fun ${name}\\(`), `${owner}.${name} needs @androidx.annotation.Keep`)
    }
  }
})
