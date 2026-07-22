import { readFile, writeFile } from 'node:fs/promises'

const manifestPath =
  process.argv[2] ?? 'src-tauri/gen/android/app/src/main/AndroidManifest.xml'

let manifest = await readFile(manifestPath, 'utf8')

if (!manifest.includes('android.permission.WAKE_LOCK')) {
  const applicationMarker = /^(\s*)<application\b/m
  const match = manifest.match(applicationMarker)
  if (!match) {
    throw new Error(`Could not find <application> in ${manifestPath}`)
  }
  const permission = `${match[1]}<uses-permission android:name="android.permission.WAKE_LOCK" />`
  manifest = manifest.replace(applicationMarker, `${permission}\n$&`)
  await writeFile(manifestPath, manifest)
}

console.log(`Configured direct-sync wake-lock permission in ${manifestPath}`)
