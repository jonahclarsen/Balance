import { readFile, writeFile } from 'node:fs/promises'

const manifestPath =
  process.argv[2] ?? 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'

let manifest = await readFile(manifestPath, 'utf8')

const permissions = [
  'android.permission.WAKE_LOCK',
  // Android's vibrator APIs, including the Chromium WebView implementation of
  // navigator.vibrate(), require this normal manifest permission.
  'android.permission.VIBRATE',
]

let changed = false
for (const permissionName of permissions) {
  if (manifest.includes(permissionName)) continue

  const applicationMarker = /^(\s*)<application\b/m
  const match = manifest.match(applicationMarker)
  if (!match) {
    throw new Error(`Could not find <application> in ${manifestPath}`)
  }
  const permission = `${match[1]}<uses-permission android:name="${permissionName}" />`
  manifest = manifest.replace(applicationMarker, `${permission}\n$&`)
  changed = true
}

if (changed) await writeFile(manifestPath, manifest)

console.log(`Configured Android wake-lock and vibration permissions in ${manifestPath}`)
