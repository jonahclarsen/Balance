import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// One-tap updates: BalanceUpdater streams the GitHub release APK into
// PackageInstaller. Android asks once to allow installs from Balance.
const root = process.argv[2] ?? 'src-tauri/gen/android/app/src/main'
const source = join(root, 'java/app/balance/local')
const activityPath = join(source, 'MainActivity.kt')
const manifestPath = join(root, 'AndroidManifest.xml')

await writeFile(join(source, 'BalanceUpdater.kt'), await readFile('.github/android/BalanceUpdater.kt', 'utf8'))

let activity = await readFile(activityPath, 'utf8')
if (!activity.includes('BalanceUpdater.attach(this)')) {
  const onCreate = /^(\s*)super\.onCreate\(savedInstanceState\)$/m
  if (!onCreate.test(activity)) throw new Error(`Could not find MainActivity's super.onCreate call in ${activityPath}`)
  activity = activity.replace(onCreate, (line, indent) => `${line}\n${indent}BalanceUpdater.attach(this)`)
  await writeFile(activityPath, activity)
}

let manifest = await readFile(manifestPath, 'utf8')
for (const permission of [
  'android.permission.REQUEST_INSTALL_PACKAGES',
  // Lets Android 12+ apply later self-updates without a confirmation sheet.
  'android.permission.UPDATE_PACKAGES_WITHOUT_USER_ACTION',
]) {
  if (manifest.includes(permission)) continue
  const application = /^(\s*)<application\b/m
  if (!application.test(manifest)) throw new Error(`Could not find <application> in ${manifestPath}`)
  manifest = manifest.replace(application, (line, indent) => `${indent}<uses-permission android:name="${permission}" />\n${line}`)
}
if (!manifest.includes('app.balance.local.BalanceUpdateReceiver')) {
  if (!/<\/application>/.test(manifest)) throw new Error(`Could not find </application> in ${manifestPath}`)
  manifest = manifest.replace(
    /^(\s*)<\/application>/m,
    (line) => `        <receiver android:name="app.balance.local.BalanceUpdateReceiver" android:exported="false" />\n${line}`,
  )
}
await writeFile(manifestPath, manifest)

console.log(`Configured one-tap Android updates in ${root}`)
