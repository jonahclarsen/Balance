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
        if (runNativeSync(applicationContext.applicationInfo.dataDir) == 0) {
            scheduleNext(applicationContext)
            Result.success()
        } else Result.retry()
    } catch (_: Throwable) {
        Result.retry()
    }
}
`,
    )
    await write(join(root, 'res/layout/balance_lock_widget.xml'), '<stale-lock-layout />')
    await write(join(root, 'res/xml/balance_lock_widget_info.xml'), '<stale-lock-info />')
    await write(
      join(root, 'res/drawable/balance_widget_violet_reminder_background.xml'),
      '<stale-reminder-background />',
    )
    await write(
      join(root, 'res/drawable/balance_widget_violet_task_circle.xml'),
      '<stale-task-circle />',
    )
    await write(
      join(root, 'res/drawable-night/balance_widget_violet_task_circle.xml'),
      '<stale-dark-task-circle />',
    )
    await write(
      join(root, 'res/drawable/balance_widget_violet_progress_fill.xml'),
      '<stale-progress-fill />',
    )
    await write(
      join(root, 'res/drawable-night/balance_widget_violet_progress_fill.xml'),
      '<stale-dark-progress-fill />',
    )

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
    assert.match(
      configuredWorker,
      /BalanceWidgets\.refreshAllAsync\(applicationContext\)[\s\S]*scheduleNext\(applicationContext\)/,
    )

    const kotlin = await readFile(
      join(root, 'java/app/balance/local/BalanceWidgets.kt'),
      'utf8',
    )
    assert.match(kotlin, /external fun nativeSnapshot/)
    assert.match(kotlin, /BalanceSyncWorker\.refreshNow\(context\)/)
    assert.match(kotlin, /R\.id\.widget_refresh_touch_target/)
    assert.doesNotMatch(kotlin, /BalanceWidgets\.refreshAllAsync\(context\) \{ pending\.finish\(\) \}/)
    assert.doesNotMatch(kotlin, /SharedPreferences|openFileOutput|writeText/)
    assert.doesNotMatch(kotlin, /BalanceLockWidgetProvider|renderLock|balance_lock_widget/)
    assert.match(kotlin, /BALANCE_WIDGET_E2E: OK home native-snapshot/)
    assert.match(kotlin, /R\.id\.widget_item_10/)
    assert.match(kotlin, /val itemDepths: List<Int>/)
    assert.match(kotlin, /val itemTimes: List<String>/)
    assert.match(kotlin, /val themeId: String/)
    assert.match(kotlin, /depthValues\?\.optInt/)
    assert.match(kotlin, /timeValues\?\.optString/)
    assert.match(kotlin, /json\.optString\("themeId", "violet"\)/)
    assert.match(kotlin, /R\.layout\.balance_home_widget_iridescent/)
    assert.match(kotlin, /R\.layout\.balance_home_widget_graphite/)
    assert.match(kotlin, /R\.layout\.balance_home_widget_ocean/)
    assert.match(kotlin, /else -> R\.layout\.balance_home_widget_violet/)
    assert.match(kotlin, /setViewPadding/)
    assert.match(kotlin, /depth \* 12 \* density/)
    assert.match(kotlin, /setProgressBar/)
    assert.match(
      kotlin,
      /R\.id\.widget_progress,[\s\S]*?if \(snapshot\.hasPlan \|\| snapshot\.unavailable\) View\.VISIBLE else View\.GONE/,
    )
    assert.match(
      kotlin,
      /R\.id\.widget_progress_glow,[\s\S]*?if \(showProgress\) View\.VISIBLE else View\.GONE/,
    )
    assert.doesNotMatch(kotlin, /Start today/)
    assert.match(kotlin, /R\.id\.widget_task_surface/)
    assert.match(kotlin, /R\.id\.widget_all_done/)
    assert.match(kotlin, /R\.id\.widget_item_time_10/)
    assert.match(kotlin, /snapshot\.items\.isEmpty\(\)/)

    const violetLayout = await readFile(
      join(root, 'res/layout/balance_home_widget_violet.xml'),
      'utf8',
    )
    assert.match(violetLayout, /@\+id\/widget_item_10/)
    assert.match(violetLayout, /@\+id\/widget_progress_bar/)
    assert.match(violetLayout, /#7355A2/)
    assert.match(violetLayout, /@drawable\/balance_widget_violet_task_circle/)
    assert.match(
      violetLayout,
      /android:id="@\+id\/widget_item_row_1"[\s\S]*?android:gravity="center_vertical"/,
    )
    assert.match(violetLayout, /@drawable\/balance_widget_violet_task_surface/)
    assert.match(violetLayout, /@drawable\/balance_widget_violet_time_pill/)
    assert.match(
      violetLayout,
      /android:id="@\+id\/widget_item_time_1"[\s\S]*?android:fontFamily="sans-serif"[\s\S]*?android:textSize="9sp"/,
    )
    assert.match(violetLayout, /@\+id\/widget_all_done/)
    assert.match(violetLayout, /android:text="TODAY"/)
    assert.match(violetLayout, /@\+id\/widget_refresh_touch_target/)
    assert.match(
      violetLayout,
      /android:id="@\+id\/widget_refresh_touch_target"[\s\S]*?android:layout_width="56dp"[\s\S]*?android:layout_height="56dp"/,
    )
    assert.match(
      violetLayout,
      /<ImageView[\s\S]*?android:id="@\+id\/widget_refresh"[\s\S]*?android:layout_width="32dp"[\s\S]*?android:layout_height="32dp"[\s\S]*?android:layout_gravity="center"[\s\S]*?android:src="@drawable\/balance_widget_violet_refresh_arrow"/,
    )
    assert.doesNotMatch(violetLayout, /android:text="↻"/)
    const refreshArrow = await readFile(
      join(root, 'res/drawable/balance_widget_violet_refresh_arrow.xml'),
      'utf8',
    )
    assert.match(refreshArrow, /<vector/)
    assert.match(refreshArrow, /android:fillColor="#7355A2"/)
    assert.match(
      violetLayout,
      /android:id="@\+id\/widget_progress_glow"[\s\S]*?android:layout_height="8dp"[\s\S]*?android:background="@drawable\/balance_widget_violet_progress_glow"[\s\S]*?android:padding="2dp"/,
    )
    assert.match(
      violetLayout,
      /android:id="@\+id\/widget_progress_bar"[\s\S]*?android:layout_height="match_parent"/,
    )
    assert.ok(
      violetLayout.indexOf('@+id/widget_reminder') <
        violetLayout.indexOf('@+id/widget_progress_bar'),
    )
    const reminder = violetLayout.match(
      /<TextView\s+android:id="@\+id\/widget_reminder"[\s\S]*?\/>/,
    )?.[0]
    assert.ok(reminder)
    assert.doesNotMatch(reminder, /android:background|android:textStyle/)

    const oceanLayout = await readFile(
      join(root, 'res/layout/balance_home_widget_ocean.xml'),
      'utf8',
    )
    assert.match(oceanLayout, /#276A9F/)
    assert.match(oceanLayout, /#172733/)

    const iridescentLayout = await readFile(
      join(root, 'res/layout/balance_home_widget_iridescent.xml'),
      'utf8',
    )
    assert.match(iridescentLayout, /#A13C91/)
    assert.match(iridescentLayout, /#7B5BD6/)
    assert.match(iridescentLayout, /#282134/)
    assert.match(iridescentLayout, /#28A987/)
    assert.match(iridescentLayout, /android:textColor="#FFFFFF"/)
    for (let index = 1; index <= 4; index += 1) {
      assert.match(
        iridescentLayout,
        new RegExp(`@drawable/balance_widget_iridescent_time_pill_${index}`),
      )
    }
    const iridescentBackground = await readFile(
      join(root, 'res/drawable/balance_widget_iridescent_background.xml'),
      'utf8',
    )
    assert.match(iridescentBackground, /<gradient/)
    assert.match(iridescentBackground, /android:startColor="#F8F3FB"/)
    assert.match(iridescentBackground, /android:centerColor="#F2F8FA"/)
    assert.match(iridescentBackground, /android:endColor="#FAF6EF"/)

    const iridescentTimePill = await readFile(
      join(root, 'res/drawable/balance_widget_iridescent_time_pill.xml'),
      'utf8',
    )
    assert.match(iridescentTimePill, /<solid android:color="#52798A"/)
    assert.doesNotMatch(iridescentTimePill, /<gradient/)

    const iridescentTimePillGradients = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        readFile(
          join(root, `res/drawable/balance_widget_iridescent_time_pill_${index + 1}.xml`),
          'utf8',
        ),
      ),
    )
    assert.match(iridescentTimePillGradients[0], /android:startColor="#4257A8"/)
    assert.match(iridescentTimePillGradients[0], /android:endColor="#6655A7"/)
    assert.match(iridescentTimePillGradients[1], /android:startColor="#6B4F92"/)
    assert.match(iridescentTimePillGradients[2], /android:startColor="#34726F"/)
    assert.match(iridescentTimePillGradients[3], /android:startColor="#825A4B"/)

    const iridescentTaskCircle = await readFile(
      join(root, 'res/drawable/balance_widget_iridescent_task_circle.xml'),
      'utf8',
    )
    assert.match(iridescentTaskCircle, /#B37B5BD6/)

    const iridescentProgress = await readFile(
      join(root, 'res/drawable/balance_widget_iridescent_progress.xml'),
      'utf8',
    )
    assert.match(iridescentProgress, /<gradient/)
    assert.match(iridescentProgress, /android:startColor="#4257C9"/)
    assert.match(iridescentProgress, /android:centerColor="#C85FB0"/)
    assert.match(iridescentProgress, /android:endColor="#F9A94F"/)

    const graphiteLayout = await readFile(
      join(root, 'res/layout/balance_home_widget_graphite.xml'),
      'utf8',
    )
    assert.match(graphiteLayout, /#3A3A38/)
    assert.match(graphiteLayout, /#191918/)
    assert.doesNotMatch(graphiteLayout, /#7355A2/)

    for (const theme of ['iridescent', 'forest', 'ocean', 'violet', 'sunset', 'crimson', 'berry', 'pink', 'mint', 'midnight', 'graphite']) {
      await readFile(join(root, `res/layout/balance_home_widget_${theme}.xml`), 'utf8')
      await readFile(join(root, `res/drawable/balance_widget_${theme}_progress.xml`), 'utf8')
      await readFile(join(root, `res/drawable/balance_widget_${theme}_progress_glow.xml`), 'utf8')
      await readFile(join(root, `res/drawable/balance_widget_${theme}_task_circle.xml`), 'utf8')
      await readFile(join(root, `res/drawable/balance_widget_${theme}_task_surface.xml`), 'utf8')
      await readFile(join(root, `res/drawable/balance_widget_${theme}_time_pill.xml`), 'utf8')
      await readFile(join(root, `res/layout-night/balance_home_widget_${theme}.xml`), 'utf8')
      await readFile(join(root, `res/drawable-night/balance_widget_${theme}_progress.xml`), 'utf8')
      await readFile(join(root, `res/drawable-night/balance_widget_${theme}_progress_glow.xml`), 'utf8')
      await assert.rejects(
        readFile(join(root, `res/drawable/balance_widget_${theme}_progress_fill.xml`), 'utf8'),
        { code: 'ENOENT' },
      )
      await assert.rejects(
        readFile(
          join(root, `res/drawable-night/balance_widget_${theme}_progress_fill.xml`),
          'utf8',
        ),
        { code: 'ENOENT' },
      )
      await readFile(
        join(root, `res/drawable-night/balance_widget_${theme}_task_circle.xml`),
        'utf8',
      )
    }

    const violetProgress = await readFile(
      join(root, 'res/drawable/balance_widget_violet_progress.xml'),
      'utf8',
    )
    assert.match(violetProgress, /<solid android:color="#DAD2E2"/)
    assert.match(violetProgress, /<solid android:color="#7355A2"/)
    assert.doesNotMatch(violetProgress, /progress_fill|<gradient/)
    const violetProgressGlow = await readFile(
      join(root, 'res/drawable/balance_widget_violet_progress_glow.xml'),
      'utf8',
    )
    assert.match(violetProgressGlow, /android:color="#1F7355A2"/)

    const darkVioletLayout = await readFile(
      join(root, 'res/layout-night/balance_home_widget_violet.xml'),
      'utf8',
    )
    assert.match(darkVioletLayout, /#201C25/)
    assert.match(darkVioletLayout, /#EEE9F2/)

    const darkIridescentBackground = await readFile(
      join(root, 'res/drawable-night/balance_widget_iridescent_background.xml'),
      'utf8',
    )
    assert.match(darkIridescentBackground, /android:startColor="#15101B"/)
    assert.match(darkIridescentBackground, /android:centerColor="#10191E"/)
    assert.match(darkIridescentBackground, /android:endColor="#1C1710"/)

    const darkIridescentProgress = await readFile(
      join(root, 'res/drawable-night/balance_widget_iridescent_progress.xml'),
      'utf8',
    )
    assert.match(darkIridescentProgress, /<gradient/)
    assert.match(darkIridescentProgress, /android:startColor="#4257C9"/)
    assert.match(darkIridescentProgress, /android:centerColor="#C85FB0"/)
    assert.match(darkIridescentProgress, /android:endColor="#F9A94F"/)

    const darkIridescentLayout = await readFile(
      join(root, 'res/layout-night/balance_home_widget_iridescent.xml'),
      'utf8',
    )
    assert.match(darkIridescentLayout, /#F5B8E3/)
    assert.match(darkIridescentLayout, /#B79AF2/)
    assert.match(darkIridescentLayout, /#65CFAA/)
    assert.match(darkIridescentLayout, /android:textColor="#FFFFFF"/)
    for (let index = 1; index <= 4; index += 1) {
      assert.match(
        darkIridescentLayout,
        new RegExp(`@drawable/balance_widget_iridescent_time_pill_${index}`),
      )
    }

    const darkIridescentTimePill = await readFile(
      join(root, 'res/drawable-night/balance_widget_iridescent_time_pill.xml'),
      'utf8',
    )
    assert.match(darkIridescentTimePill, /<solid android:color="#4C6877"/)
    assert.doesNotMatch(darkIridescentTimePill, /<gradient/)

    const darkIridescentTimePillGradients = await Promise.all(
      Array.from({ length: 4 }, (_, index) =>
        readFile(
          join(root, `res/drawable-night/balance_widget_iridescent_time_pill_${index + 1}.xml`),
          'utf8',
        ),
      ),
    )
    assert.match(darkIridescentTimePillGradients[0], /android:startColor="#4A5E91"/)
    assert.match(darkIridescentTimePillGradients[0], /android:endColor="#645586"/)
    assert.match(darkIridescentTimePillGradients[1], /android:startColor="#654F80"/)
    assert.match(darkIridescentTimePillGradients[2], /android:startColor="#3F706B"/)
    assert.match(darkIridescentTimePillGradients[3], /android:startColor="#7B594C"/)

    const darkGraphiteLayout = await readFile(
      join(root, 'res/layout-night/balance_home_widget_graphite.xml'),
      'utf8',
    )
    assert.match(darkGraphiteLayout, /#70706E/)
    assert.match(darkGraphiteLayout, /#F0F0ED/)
    assert.match(darkGraphiteLayout, /android:textColor="#FFFFFF"/)
    assert.doesNotMatch(darkGraphiteLayout, /#B69ADB/)
    const darkGraphiteBackground = await readFile(
      join(root, 'res/drawable-night/balance_widget_graphite_background.xml'),
      'utf8',
    )
    assert.match(darkGraphiteBackground, /#161617/)

    const widgetStyles = await readFile(
      join(root, 'res/values/balance_widget_styles.xml'),
      'utf8',
    )
    assert.match(widgetStyles, /android:maxLines">2</)
    assert.doesNotMatch(widgetStyles, /balance_widget_task_circle/)

    const widgetTaskSurface = await readFile(
      join(root, 'res/drawable/balance_widget_mint_task_surface.xml'),
      'utf8',
    )
    assert.match(widgetTaskSurface, /#FFFFFF/)

    const darkWidgetTaskSurface = await readFile(
      join(root, 'res/drawable-night/balance_widget_mint_task_surface.xml'),
      'utf8',
    )
    assert.match(darkWidgetTaskSurface, /#202E29/)

    const homeInfo = await readFile(
      join(root, 'res/xml/balance_home_widget_info.xml'),
      'utf8',
    )
    assert.match(homeInfo, /widgetCategory="home_screen"/)
    assert.match(homeInfo, /@layout\/balance_home_widget_violet/)
    await assert.rejects(
      readFile(join(root, 'res/layout/balance_home_widget.xml'), 'utf8'),
      { code: 'ENOENT' },
    )
    await assert.rejects(
      readFile(join(root, 'res/layout/balance_lock_widget.xml'), 'utf8'),
      { code: 'ENOENT' },
    )
    await assert.rejects(
      readFile(join(root, 'res/xml/balance_lock_widget_info.xml'), 'utf8'),
      { code: 'ENOENT' },
    )
    await assert.rejects(
      readFile(join(root, 'res/drawable/balance_widget_violet_reminder_background.xml'), 'utf8'),
      { code: 'ENOENT' },
    )
  } finally {
    await rm(fixture, { recursive: true, force: true })
  }
})
