import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('updater integration is idempotent and installs through a private receiver', async () => {
  const root = await mkdtemp(join(tmpdir(), 'balance-updater-generator-'))
  try {
    const source = join(root, 'java/app/balance/local')
    await mkdir(source, { recursive: true })
    await writeFile(
      join(source, 'MainActivity.kt'),
      'class MainActivity : TauriActivity() {\n  override fun onCreate(savedInstanceState: Bundle?) {\n    super.onCreate(savedInstanceState)\n  }\n}\n',
    )
    await writeFile(join(root, 'AndroidManifest.xml'), '<manifest>\n    <application>\n    </application>\n</manifest>\n')
    const run = () => execFileSync(process.execPath, ['.github/scripts/configure-android-updater.mjs', root])
    const paths = ['AndroidManifest.xml', 'java/app/balance/local/MainActivity.kt', 'java/app/balance/local/BalanceUpdater.kt']
    run()
    const first = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')))
    run()
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8'))), first)

    const [manifest, activity, updater] = first
    assert.match(manifest, /REQUEST_INSTALL_PACKAGES/)
    assert.match(manifest, /UPDATE_PACKAGES_WITHOUT_USER_ACTION/)
    assert.match(manifest, /BalanceUpdateReceiver" android:exported="false"/)
    assert.match(activity, /super\.onCreate\(savedInstanceState\)\n\s*BalanceUpdater\.attach\(this\)/)
    // Only this repository's release assets can be installed.
    assert.match(updater, /"https:\/\/github\.com\/jonahclarsen\/Balance\/releases\/download\/"/)
    assert.match(updater, /TAG_PATTERN\.matches\(tag\)/)
    assert.match(updater, /STATUS_PENDING_USER_ACTION/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
