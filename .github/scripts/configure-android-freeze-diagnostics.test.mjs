import assert from 'node:assert/strict'
import {execFile} from 'node:child_process'
import {mkdtemp, mkdir, readFile, writeFile, rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join, resolve} from 'node:path'
import {promisify} from 'node:util'
import test from 'node:test'
const run = promisify(execFile)
test('lifecycle hooks precede existing resume work and sharing exposes only the report cache', async () => {
  const root = await mkdtemp(join(tmpdir(), 'balance-freeze-config-'))
  const source = join(root, 'java/app/balance/local')
  try {
    await mkdir(source, {recursive:true})
    await writeFile(join(source, 'MainActivity.kt'), 'class MainActivity : TauriActivity() {\n override fun onResume() { super.onResume(); BalanceTaskNotifications.resume(this) }\n}\n')
    await writeFile(join(root, 'AndroidManifest.xml'), '<manifest><application></application></manifest>')
    for (let i=0;i<2;i++) await run(process.execPath, [resolve('.github/scripts/configure-android-freeze-diagnostics.mjs'), root])
    const activity = await readFile(join(source, 'MainActivity.kt'), 'utf8')
    assert.equal((activity.match(/BalanceFreezeDiagnostics.resume/g)??[]).length, 1)
    assert.ok(activity.indexOf('BalanceFreezeDiagnostics.resume') < activity.indexOf('super.onResume'))
    assert.ok(activity.indexOf('BalanceFreezeDiagnostics.pause') < activity.indexOf('super.onPause'))
    const manifest = await readFile(join(root, 'AndroidManifest.xml'), 'utf8')
    assert.equal((manifest.match(/app\.balance\.local\.BalanceFreezeReportProvider/g)??[]).length, 1)
    assert.match(manifest, /\$\{applicationId\}\.freeze-reports/)
    assert.match(manifest, /android:exported="false"/)
    const paths = await readFile(join(root, 'res/xml/freeze_report_paths.xml'), 'utf8')
    assert.match(paths, /path="freeze-reports\/"/)
    assert.doesNotMatch(paths, /root-path|external-path|path="\."/)
  } finally { await rm(root, {recursive:true,force:true}) }
})
