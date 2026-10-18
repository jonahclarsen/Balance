import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.argv[2] ?? 'src-tauri/gen/android/app/src/main'
const source = join(root, 'java/app/balance/local')
await mkdir(source, { recursive: true })
for (const file of ['BalanceSituate.kt', 'NotificationArchive.kt', 'SituateSelfTest.kt']) await copyFile(`src-tauri/android/situate/${file}`, join(source, file))
const activityPath = join(source, 'MainActivity.kt')
let activity = await readFile(activityPath, 'utf8')
if (!activity.includes('BalanceSituate.resume(this)')) {
  if (!activity.includes('super.onResume()')) throw new Error('Generate task notifications before Situate')
  activity = activity.replace('super.onResume()', 'super.onResume()\n        BalanceSituate.resume(this)')
  if (/override fun onNewIntent/.test(activity)) throw new Error('Integrate Situate with existing onNewIntent explicitly')
  const end = activity.lastIndexOf('}')
  activity = activity.slice(0,end) + '\n    override fun onNewIntent(intent: android.content.Intent) {\n        super.onNewIntent(intent)\n        setIntent(intent)\n        BalanceSituate.resume(this)\n    }\n' + activity.slice(end)
  await writeFile(activityPath, activity)
}
const manifestPath = join(root,'AndroidManifest.xml')
let manifest = await readFile(manifestPath,'utf8')
if (!manifest.includes('.SituateNotifications')) {
  manifest = manifest.replace('</application>', `
    <service android:name=".SituateNotifications" android:label="Situate notification history" android:permission="android.permission.BIND_NOTIFICATION_LISTENER_SERVICE" android:exported="true">
      <intent-filter><action android:name="android.service.notification.NotificationListenerService" /></intent-filter>
    </service>
    <service android:name=".SituateAccessibility" android:label="Situate app blocking" android:permission="android.permission.BIND_ACCESSIBILITY_SERVICE" android:exported="true">
      <intent-filter><action android:name="android.accessibilityservice.AccessibilityService" /></intent-filter>
      <meta-data android:name="android.accessibilityservice" android:resource="@xml/situate_accessibility" />
    </service>
    <activity android:name=".SituateBlockedActivity" android:exported="false" android:excludeFromRecents="true" />
    <activity android:name=".SituateExportActivity" android:exported="false" android:excludeFromRecents="true" />
    <receiver android:name=".SituateReceiver" android:exported="false"><intent-filter>
      <action android:name="android.intent.action.BOOT_COMPLETED" /><action android:name="android.intent.action.MY_PACKAGE_REPLACED" />
      <action android:name="android.intent.action.TIME_SET" /><action android:name="android.intent.action.TIMEZONE_CHANGED" />
    </intent-filter></receiver>
  </application>`)
  // Tauri's existing activity remains the only exported UI entry point.
  manifest = manifest.replace(/(<activity\b[^>]*android:name="\.MainActivity"[^>]*>)/, '$1\n<intent-filter><action android:name="android.intent.action.VIEW" /><category android:name="android.intent.category.DEFAULT" /><category android:name="android.intent.category.BROWSABLE" /><data android:scheme="balance" android:host="situate" /></intent-filter>')
  await writeFile(manifestPath,manifest)
}
await mkdir(join(root,'res/xml'),{recursive:true})
await writeFile(join(root,'res/xml/situate_accessibility.xml'), `<?xml version="1.0" encoding="utf-8"?>
<accessibility-service xmlns:android="http://schemas.android.com/apk/res/android"
 android:accessibilityEventTypes="typeWindowStateChanged" android:accessibilityFeedbackType="feedbackGeneric"
 android:notificationTimeout="100" android:canRetrieveWindowContent="false" android:canPerformGestures="false"
 android:description="@string/situate_accessibility_description" />\n`)
await mkdir(join(root,'res/values'),{recursive:true})
await writeFile(join(root,'res/values/situate.xml'), '<resources><string name="situate_accessibility_description">Checks app identities to redirect blocked apps to a quiz. Does not read screen text or perform gestures.</string></resources>\n')
