import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execFileSync } from 'node:child_process'
test('Situate generation is idempotent and services expose only OS-bound capabilities',async()=>{
 const root=await mkdtemp(join(tmpdir(),'situate-generator-'))
 try {
  const source=join(root,'java/app/balance/local');await mkdir(source,{recursive:true})
  await writeFile(join(source,'MainActivity.kt'),'class MainActivity : TauriActivity() {\n override fun onResume() { super.onResume() }\n}\n')
  await writeFile(join(root,'AndroidManifest.xml'),'<manifest><application><activity android:name=".MainActivity"></activity></application></manifest>')
  const run=()=>execFileSync(process.execPath,['.github/scripts/configure-android-situate.mjs',root])
  run();const first=await readFile(join(root,'AndroidManifest.xml'),'utf8');run();assert.equal(await readFile(join(root,'AndroidManifest.xml'),'utf8'),first)
  assert.match(first,/<data android:scheme="balance" \/>/);assert.doesNotMatch(first,/android:host="situate"/)
  await writeFile(join(root,'AndroidManifest.xml'), first.replace('android:scheme="balance"', 'android:scheme="balance" android:host="situate"'))
  run();assert.equal(await readFile(join(root,'AndroidManifest.xml'),'utf8'),first)
  assert.match(first,/BIND_NOTIFICATION_LISTENER_SERVICE/);assert.match(first,/BIND_ACCESSIBILITY_SERVICE/)
  assert.match(first,/SituateExportActivity" android:exported="false"/)
  const xml=await readFile(join(root,'res/xml/situate_accessibility.xml'),'utf8');assert.match(xml,/canRetrieveWindowContent="false"/);assert.match(xml,/canPerformGestures="false"/)
  const kotlin=await readFile(join(source,'NotificationArchive.kt'),'utf8');assert.match(kotlin,/noBackupFilesDir/);assert.match(kotlin,/AES\/GCM\/NoPadding/);assert.match(kotlin,/HmacSHA256/)
  const activity=await readFile(join(source,'MainActivity.kt'),'utf8');assert.equal(activity.match(/override fun onNewIntent/g).length,1)
 } finally { await rm(root,{recursive:true,force:true}) }
})
