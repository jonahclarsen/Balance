import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

test('voice input integration is idempotent and declares headset routing and background recording', async () => {
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
    for (const permission of ['RECORD_AUDIO', 'MODIFY_AUDIO_SETTINGS', 'BLUETOOTH_CONNECT', 'POST_NOTIFICATIONS', 'FOREGROUND_SERVICE', 'FOREGROUND_SERVICE_MICROPHONE']) {
      assert.match(manifest, new RegExp(`"android\\.permission\\.${permission}"`))
    }
    assert.match(manifest, /"android\.permission\.BLUETOOTH" android:maxSdkVersion="30"/)
    assert.match(manifest, /BalanceVoiceRecordingService" android:exported="false" android:foregroundServiceType="microphone"/)
    assert.match(activity, /override fun onWebViewCreate\(webView: android\.webkit\.WebView\) \{\n\s*super\.onWebViewCreate\(webView\)\n\s*BalanceVoiceInput\.attach\(this, webView\)/)
    for (const density of ['mdpi', 'hdpi', 'xhdpi', 'xxhdpi', 'xxxhdpi']) await access(join(root, `res/drawable-${density}/ic_balance_notification.png`))
    assert.match(bridge, /setSmallIcon\(R\.drawable\.ic_balance_notification\)/)
    assert.match(bridge, /addJavascriptInterface\(BalanceVoiceInput\(activity\), "BalanceVoiceInput"\)/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
