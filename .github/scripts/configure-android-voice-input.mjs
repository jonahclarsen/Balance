import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Voice ideas record through the WebView's getUserMedia. wry asks for the
// microphone itself; Bluetooth headsets also need BLUETOOTH_CONNECT, and a
// microphone foreground service keeps recording behind a notification.
const root = process.argv[2] ?? 'src-tauri/gen/android/app/src/main'
const source = join(root, 'java/app/balance/local')
const activityPath = join(source, 'MainActivity.kt')
const manifestPath = join(root, 'AndroidManifest.xml')

await writeFile(join(source, 'BalanceVoiceInput.kt'), await readFile(new URL('../android/BalanceVoiceInput.kt', import.meta.url), 'utf8'))

// The recording notification shows the app's logo, traced from app-icon.png.
const resources = new URL('../android/res/', import.meta.url)
for (const density of await readdir(resources)) {
  if (!density.startsWith('drawable-')) continue
  await mkdir(join(root, 'res', density), { recursive: true })
  await copyFile(new URL(`${density}/ic_balance_notification.png`, resources), join(root, 'res', density, 'ic_balance_notification.png'))
}

let activity = await readFile(activityPath, 'utf8')
if (!activity.includes('BalanceVoiceInput.attach(this, webView)')) {
  const end = activity.lastIndexOf('}')
  if (end < 0 || !/class MainActivity\s*:\s*TauriActivity\(\)\s*\{/.test(activity)) {
    throw new Error(`Expected initialized MainActivity body in ${activityPath}`)
  }
  activity = activity.slice(0, end) + `
    override fun onWebViewCreate(webView: android.webkit.WebView) {
        super.onWebViewCreate(webView)
        BalanceVoiceInput.attach(this, webView)
    }
` + activity.slice(end)
  await writeFile(activityPath, activity)
}

let manifest = await readFile(manifestPath, 'utf8')
for (const permission of [
  'android.permission.RECORD_AUDIO',
  'android.permission.MODIFY_AUDIO_SETTINGS',
  'android.permission.BLUETOOTH_CONNECT',
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.FOREGROUND_SERVICE',
  'android.permission.FOREGROUND_SERVICE_MICROPHONE',
]) {
  if (manifest.includes(`"${permission}"`)) continue
  const application = /^(\s*)<application\b/m
  if (!application.test(manifest)) throw new Error(`Could not find <application> in ${manifestPath}`)
  manifest = manifest.replace(application, (line, indent) => `${indent}<uses-permission android:name="${permission}" />\n${line}`)
}
// Before Android 12, Bluetooth headset routing used the install-time permission.
if (!manifest.includes('"android.permission.BLUETOOTH"')) {
  manifest = manifest.replace(/^(\s*)<application\b/m, (line, indent) => `${indent}<uses-permission android:name="android.permission.BLUETOOTH" android:maxSdkVersion="30" />\n${line}`)
}
if (!manifest.includes('app.balance.local.BalanceVoiceRecordingService')) {
  if (!manifest.includes('</application>')) throw new Error(`Could not find </application> in ${manifestPath}`)
  manifest = manifest.replace(/^(\s*)<\/application>/m, (line) => `        <service android:name="app.balance.local.BalanceVoiceRecordingService" android:exported="false" android:foregroundServiceType="microphone" android:stopWithTask="true" />\n${line}`)
}
await writeFile(manifestPath, manifest)

console.log(`Configured voice idea recording in ${root}`)
