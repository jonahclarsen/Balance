import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('voice input integration is idempotent and grants headset routing permissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'balance-voice-input-generator-'))
  try {
    const source = join(root, 'java/app/balance/local')
    await mkdir(source, { recursive: true })
    await writeFile(join(source, 'MainActivity.kt'), 'class MainActivity : TauriActivity() {\n}\n')
    await writeFile(join(root, 'AndroidManifest.xml'), '<manifest>\n    <application>\n    </application>\n</manifest>\n')
    const run = () => execFileSync(process.execPath, ['.github/scripts/configure-android-voice-input.mjs', root])
    const paths = ['AndroidManifest.xml', 'java/app/balance/local/MainActivity.kt', 'java/app/balance/local/BalanceVoiceInput.kt']
    run()
    const first = await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8')))
    run()
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(join(root, path), 'utf8'))), first)

    const [manifest, activity, bridge] = first
    for (const permission of ['RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'BLUETOOTH_CONNECT']) {
      assert.match(manifest, new RegExp(`"android\\.permission\\.${permission}"`))
    }
    assert.match(manifest, /"android\.permission\.BLUETOOTH" android:maxSdkVersion="30"/)
    assert.match(activity, /override fun onWebViewCreate\(webView: android\.webkit\.WebView\) \{\n\s*super\.onWebViewCreate\(webView\)\n\s*BalanceVoiceInput\.attach\(this, webView\)/)
    assert.match(bridge, /addJavascriptInterface\(BalanceVoiceInput\(activity\), "BalanceVoiceInput"\)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
