import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.argv[2] ?? 'src-tauri/gen/android/app/src/main'
const sourceRoot = join(root, 'java/app/balance/local')
const activityPath = join(sourceRoot, 'MainActivity.kt')
const workerPath = join(sourceRoot, 'BalanceSyncWorker.kt')
const manifestPath = join(root, 'AndroidManifest.xml')
let activity = await readFile(activityPath, 'utf8')
const resume = 'BalanceTaskNotifications.resume(this)'
if (!activity.includes(resume)) {
  if (/super\.onResume\(\)/.test(activity)) {
    activity = activity.replace('super.onResume()', `super.onResume()\n        ${resume}`)
  } else {
    const end = activity.lastIndexOf('}')
    if (end < 0 || !/class MainActivity\s*:\s*TauriActivity\(\)\s*\{/.test(activity)) throw new Error('Expected initialized MainActivity')
    activity = activity.slice(0, end) + `\n    override fun onResume() {\n        super.onResume()\n        ${resume}\n    }\n` + activity.slice(end)
  }
  const end = activity.lastIndexOf('}')
  activity = activity.slice(0, end) + `
    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        if (requestCode == 42819) BalanceTaskNotifications.refresh(this)
    }
    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) BalanceTaskNotifications.refresh(this)
    }
` + activity.slice(end)
  await writeFile(activityPath, activity)
}
let worker = await readFile(workerPath, 'utf8')
if (!worker.includes('BalanceTaskNotifications.initialize(applicationContext)')) {
  if (!worker.includes('override fun doWork(): Result {')) throw new Error('Expected the background sync worker')
  worker = worker.replace('override fun doWork(): Result {', 'override fun doWork(): Result {\n        BalanceTaskNotifications.initialize(applicationContext)')
  await writeFile(workerPath, worker)
}
let manifest = await readFile(manifestPath, 'utf8')
for (const name of ['POST_NOTIFICATIONS', 'SCHEDULE_EXACT_ALARM', 'RECEIVE_BOOT_COMPLETED']) {
  if (!manifest.includes(`android.permission.${name}`)) {
    manifest = manifest.replace('<application', `<uses-permission android:name="android.permission.${name}" />\n    <application`)
  }
}
if (!manifest.includes('.BalanceTaskNotificationReceiver')) {
  manifest = manifest.replace('</application>', `
        <receiver android:name=".BalanceTaskNotificationReceiver" android:exported="false" />
        <receiver android:name=".BalanceTaskNotificationRestoreReceiver" android:exported="false">
            <intent-filter>
                <action android:name="android.intent.action.BOOT_COMPLETED" />
                <action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
                <action android:name="android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED" />
            </intent-filter>
        </receiver>
    </application>`)
}
await writeFile(manifestPath, manifest)
await writeFile(join(sourceRoot, 'BalanceTaskNotifications.kt'), await readFile(new URL('../android/BalanceTaskNotifications.kt', import.meta.url)))
await mkdir(join(root, 'res/drawable'), { recursive: true })
await writeFile(join(root, 'res/drawable/ic_task_notification.xml'), `<vector xmlns:android="http://schemas.android.com/apk/res/android" android:width="24dp" android:height="24dp" android:viewportWidth="24" android:viewportHeight="24">
    <path android:fillColor="#FFFFFFFF" android:pathData="M12,22a2,2 0,0 0,2 -2h-4a2,2 0,0 0,2 2M18,16v-5a6,6 0,0 0,-5 -5.91V3h-2v2.09A6,6 0,0 0,6 11v5l-2,2v1h16v-1z" />
</vector>\n`)
