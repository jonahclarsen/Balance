import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Voice ideas record through the WebView's getUserMedia. wry asks for the
// microphone itself; Bluetooth headsets also need BLUETOOTH_CONNECT.
const root = process.argv[2] ?? 'src-tauri/gen/android/app/src/main'
const source = join(root, 'java/app/balance/local')
const activityPath = join(source, 'MainActivity.kt')
const manifestPath = join(root, 'AndroidManifest.xml')

await writeFile(join(source, 'BalanceVoiceInput.kt'), await readFile(new URL('../android/BalanceVoiceInput.kt', import.meta.url), 'utf8'))

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
await writeFile(manifestPath, manifest)

console.log(`Configured voice idea recording in ${root}`)
