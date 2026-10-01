import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('notification integration is idempotent and includes private alarm receivers and permission hooks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'balance-notification-generator-'))
  try {
    const source = join(root, 'java/app/balance/local')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'MainActivity.kt'), 'class MainActivity : TauriActivity() {\n override fun onStart() { super.onStart() }\n}')
    await writeFile(join(source, 'BalanceSyncWorker.kt'), 'override fun doWork(): Result { return Result.success() }')
    await writeFile(join(root, 'AndroidManifest.xml'), '<manifest><application></application></manifest>')
    const run = () => execFileSync(process.execPath, ['.github/scripts/configure-android-task-notifications.mjs', root])
    run()
    const paths = ['AndroidManifest.xml', 'java/app/balance/local/MainActivity.kt', 'java/app/balance/local/BalanceSyncWorker.kt', 'java/app/balance/local/BalanceTaskNotifications.kt', 'res/drawable/ic_task_notification.xml']
    const first = await Promise.all(paths.map(path => readFile(join(root, path), 'utf8')))
    run()
    assert.deepEqual(await Promise.all(paths.map(path => readFile(join(root, path), 'utf8'))), first)
    assert.match(first[0], /SCHEDULE_EXACT_ALARM/)
    assert.match(first[0], /POST_NOTIFICATIONS/)
    assert.match(first[0], /BOOT_COMPLETED/)
    assert.equal((first[0].match(/android:exported="false"/g) ?? []).length, 2)
    assert.match(first[1], /BalanceTaskNotifications.resume\(this\)/)
    assert.match(first[2], /BalanceTaskNotifications.initialize\(applicationContext\)/)
  } finally { await rm(root, { recursive: true, force: true }) }
})
