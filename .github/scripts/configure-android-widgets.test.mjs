import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import test from 'node:test'

const execute = promisify(execFile)
const script = resolve('.github/scripts/configure-android-widgets.mjs')

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, content)
}

test('configures both Android widget providers idempotently', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'balance-widgets-'))
  const root = join(fixture, 'app/src/main')
  const activity = join(root, 'java/app/balance/local/MainActivity.kt')
  const worker = join(root, 'java/app/balance/local/BalanceSyncWorker.kt')

  try {
    await write(
      join(root, 'AndroidManifest.xml'),
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="Balance">
  </application>
</manifest>
`,
    )
    await write(
      activity,
      `package app.balance.local

import android.os.Bundle

class MainActivity : TauriActivity() {
  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    BalanceSyncWorker.schedule(this)
  }
}
`,
    )
    await write(
      worker,
      `package app.balance.local

class BalanceSyncWorker {
    fun doWork(): Result = try {
        if (runNativeSync(applicationContext.applicationInfo.dataDir) == 0) Result.success()
        else Result.retry()
    } catch (_: Throwable) {
        Result.retry()
    }
}
`,
    )

    await execute(process.execPath, [script, root, activity, worker])
    await execute(process.execPath, [script, root, activity, worker])

    const manifest = await readFile(join(root, 'AndroidManifest.xml'), 'utf8')
    assert.equal((manifest.match(/BalanceHomeWidgetProvider/g) ?? []).length, 1)
    assert.equal((manifest.match(/BalanceLockWidgetProvider/g) ?? []).length, 1)
    assert.match(manifest, /@xml\/balance_home_widget_info/)
    assert.match(manifest, /@xml\/balance_lock_widget_info/)

    const configuredActivity = await readFile(activity, 'utf8')
    assert.equal(
      (configuredActivity.match(/BalanceWidgets\.scheduleSelfTest\(this\)/g) ?? []).length,
      1,
    )
    assert.equal(
      (configuredActivity.match(/BalanceWidgets\.refreshAllAsync\(this\)/g) ?? []).length,
      1,
    )

    const configuredWorker = await readFile(worker, 'utf8')
    assert.equal(
      (configuredWorker.match(/BalanceWidgets\.refreshAllAsync\(applicationContext\)/g) ?? [])
        .length,
      1,
    )

    const kotlin = await readFile(
      join(root, 'java/app/balance/local/BalanceWidgets.kt'),
      'utf8',
    )
    assert.match(kotlin, /external fun nativeSnapshot/)
    assert.match(kotlin, /getReceiverInfo/)
    assert.match(kotlin, /getAttributeIntValue/)
    assert.match(kotlin, /initialKeyguardLayout/)
    assert.match(kotlin, /BALANCE_WIDGET_E2E: OK home\+keyguard native-snapshot/)
    assert.match(kotlin, /R\.id\.widget_item_10/)

    const homeLayout = await readFile(
      join(root, 'res/layout/balance_home_widget.xml'),
      'utf8',
    )
    assert.match(homeLayout, /@\+id\/widget_item_10/)

    const homeInfo = await readFile(
      join(root, 'res/xml/balance_home_widget_info.xml'),
      'utf8',
    )
    const lockInfo = await readFile(
      join(root, 'res/xml/balance_lock_widget_info.xml'),
      'utf8',
    )
    assert.match(homeInfo, /widgetCategory="home_screen"/)
    assert.match(lockInfo, /widgetCategory="keyguard"/)
    assert.match(lockInfo, /initialKeyguardLayout="@layout\/balance_lock_widget"/)
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
