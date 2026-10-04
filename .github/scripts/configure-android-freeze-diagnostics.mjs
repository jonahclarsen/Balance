import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
const root = process.argv[2] ?? 'src-tauri/gen/android/app/src/main'
const source = join(root, 'java/app/balance/local')
const activityPath = join(source, 'MainActivity.kt')
let activity = await readFile(activityPath, 'utf8')
for (const [method, call] of [['onResume', 'BalanceFreezeDiagnostics.resume(this)'], ['onPause', 'BalanceFreezeDiagnostics.pause()']]) {
  if (activity.includes(call)) continue
  const marker = `super.${method}()`
  if (activity.includes(marker)) activity = activity.replace(marker, `${call}\n        ${marker}`)
  else {
    const end = activity.lastIndexOf('}')
    if (end < 0) throw new Error('Expected initialized Android activity')
    activity = activity.slice(0, end) + `\n    override fun ${method}() {\n        ${call}\n        ${marker}\n    }\n` + activity.slice(end)
  }
}
await writeFile(activityPath, activity)
await writeFile(join(source, 'BalanceFreezeDiagnostics.kt'), await readFile('.github/android/BalanceFreezeDiagnostics.kt', 'utf8'))
const manifestPath = join(root, 'AndroidManifest.xml')
let manifest = await readFile(manifestPath, 'utf8')
if (!manifest.includes('.freeze-reports')) {
  manifest = manifest.replace('</application>', `<provider android:name="androidx.core.content.FileProvider" android:authorities="\${applicationId}.freeze-reports" android:exported="false" android:grantUriPermissions="true"><meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/freeze_report_paths" /></provider>\n</application>`)
  await writeFile(manifestPath, manifest)
}
await mkdir(join(root, 'res/xml'), {recursive: true})
await writeFile(join(root, 'res/xml/freeze_report_paths.xml'), '<paths xmlns:android="http://schemas.android.com/apk/res/android"><cache-path name="freeze-reports" path="freeze-reports/" /></paths>\n')
