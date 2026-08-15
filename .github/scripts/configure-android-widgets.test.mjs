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

test('configures the Android home-screen widget idempotently', async () => {
  const fixture = await mkdtemp(join(tmpdir(), 'balance-widgets-'))
  const root = join(fixture, 'app/src/main')
  const activity = join(root, 'java/app/balance/local/MainActivity.kt')
  const worker = join(root, 'java/app/balance/local/BalanceSyncWorker.kt')

  try {
    await write(
      join(root, 'AndroidManifest.xml'),
      `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application android:label="Balance">
    <receiver
        android:name=".BalanceLockWidgetProvider"
        android:exported="false"
        android:label="@string/balance_lock_widget_name">
      <meta-data
          android:name="android.appwidget.provider"
          android:resource="@xml/balance_lock_widget_info" />
    </receiver>
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
  }

  override fun onStart() {
    super.onStart()
    BalanceSyncWorker.enterForeground(this)
  }

  override fun onStop() {
    super.onStop()
    BalanceSyncWorker.enterBackground(this)
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
    await write(join(root, 'res/layout/balance_lock_widget.xml'), '<stale-lock-layout />')
    await write(join(root, 'res/xml/balance_lock_widget_info.xml'), '<stale-lock-info />')

    await execute(process.execPath, [script, root, activity, worker])
    await execute(process.execPath, [script, root, activity, worker])

    const manifest = await readFile(join(root, 'AndroidManifest.xml'), 'utf8')
    assert.equal((manifest.match(/BalanceHomeWidgetProvider/g) ?? []).length, 1)
    assert.doesNotMatch(manifest, /BalanceLockWidgetProvider|balance_lock_widget/)
    assert.equal((manifest.match(/android:exported="false"/g) ?? []).length, 1)
    assert.match(manifest, /@xml\/balance_home_widget_info/)

    const configuredActivity = await readFile(activity, 'utf8')
    assert.equal(
      (configuredActivity.match(/BalanceWidgets\.scheduleSelfTest\(this\)/g) ?? []).length,
      1,
    )
    assert.equal(
      (configuredActivity.match(/BalanceWidgets\.refreshAllAsync\(this\)/g) ?? []).length,
      1,
    )
    assert.equal((configuredActivity.match(/override fun onStop/g) ?? []).length, 1)
    assert.match(configuredActivity, /BalanceSyncWorker\.enterBackground\(this\)/)

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
    assert.doesNotMatch(kotlin, /SharedPreferences|openFileOutput|writeText/)
    assert.doesNotMatch(kotlin, /BalanceLockWidgetProvider|renderLock|balance_lock_widget/)
    assert.match(kotlin, /BALANCE_WIDGET_E2E: OK home native-snapshot/)
    assert.match(kotlin, /R\.id\.widget_item_10/)
    assert.match(kotlin, /val itemDepths: List<Int>/)
    assert.match(kotlin, /val itemTimes: List<String>/)
    assert.match(kotlin, /depthValues\?\.optInt/)
    assert.match(kotlin, /timeValues\?\.optString/)
    assert.match(kotlin, /repeat\(depth\)/)

    const homeLayout = await readFile(
      join(root, 'res/layout/balance_home_widget.xml'),
      'utf8',
    )
    assert.match(homeLayout, /@\+id\/widget_item_10/)

    const homeInfo = await readFile(
      join(root, 'res/xml/balance_home_widget_info.xml'),
      'utf8',
    )
    assert.match(homeInfo, /widgetCategory="home_screen"/)
    await assert.rejects(
      readFile(join(root, 'res/layout/balance_lock_widget.xml'), 'utf8'),
      { code: 'ENOENT' },
    )
    await assert.rejects(
      readFile(join(root, 'res/xml/balance_lock_widget_info.xml'), 'utf8'),
      { code: 'ENOENT' },
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
