import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('installs selection formatting idempotently without replacing activity lifecycle hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'balance-selection-'))
  try {
    const activity = join(root, 'MainActivity.kt')
    const original = 'package app.balance.local\nclass MainActivity : TauriActivity() {\n  override fun onStart() { super.onStart() }\n}\n'
    await writeFile(activity, original)
    const run = () => execFileSync(process.execPath, ['.github/scripts/configure-android-selection-formatting.mjs', activity])
    run()
    const first = await readFile(activity, 'utf8')
    run()
    assert.equal(await readFile(activity, 'utf8'), first)
    assert.ok(first.includes('override fun onStart() { super.onStart() }'))
    const source = await readFile(join(root, 'BalanceSelectionFormatting.kt'), 'utf8')
    assert.ok(!source.includes('__SELECTION_SCRIPT__'))
    assert.ok(source.includes('balanceformat'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
