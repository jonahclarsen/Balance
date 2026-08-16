import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { promisify } from 'node:util'

const execute = promisify(execFile)
const script = new URL('./configure-android-sync-wake-lock.mjs', import.meta.url)
const fixture = `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android">
    <application android:label="Balance" />
</manifest>
`

test('adds wake-lock and vibration permissions idempotently', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'balance-android-permissions-'))
  const manifestPath = join(directory, 'AndroidManifest.xml')
  await writeFile(manifestPath, fixture)

  await execute(process.execPath, [script.pathname, manifestPath])
  await execute(process.execPath, [script.pathname, manifestPath])

  const manifest = await readFile(manifestPath, 'utf8')
  assert.equal(manifest.match(/android\.permission\.WAKE_LOCK/g)?.length, 1)
  assert.equal(manifest.match(/android\.permission\.VIBRATE/g)?.length, 1)
  assert.ok(manifest.indexOf('android.permission.VIBRATE') < manifest.indexOf('<application'))
})
