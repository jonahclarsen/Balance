import { test } from 'node:test'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync, rmSync, copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import assert from 'node:assert/strict'

test('Siri waits for a matching saved receipt and handles failed handoffs', {
  skip: process.platform !== 'darwin',
}, async () => {
  const root = resolve(import.meta.dirname, '..')
  const temporary = mkdtempSync(join(tmpdir(), 'balance-siri-confirmation-'))
  try {
    const binary = join(temporary, 'confirmation-tests')
    execFileSync('xcrun', ['swiftc', '-parse-as-library',
      'src-tauri/macos/BalanceIntents/AddToBalanceIntent.swift',
      'src-tauri/macos/WidgetBridge.swift',
      'tests/native/siri-confirmation.swift',
      '-framework', 'AppKit', '-framework', 'WidgetKit', '-framework', 'Security',
      '-o', binary,
    ], { cwd: root, stdio: 'inherit' })
    execFileSync(binary, [], { timeout: 15_000, stdio: 'inherit' })
    const app = join(temporary, 'SyntheticSiriReceiver.app')
    mkdirSync(join(app, 'Contents/MacOS'), { recursive: true })
    const sandboxed = join(app, 'Contents/MacOS/sandboxed-receiver')
    copyFileSync(binary, sandboxed)
    writeFileSync(join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.balance.synthetic-siri-confirmation</string>
<key>CFBundleExecutable</key><string>sandboxed-receiver</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSUIElement</key><true/>
</dict></plist>`)

    execFileSync('codesign', ['--force', '--sign', '-',
      '--identifier', 'app.balance.synthetic-siri-confirmation',
      '--entitlements', join(root, 'src-tauri/macos/BalanceIntents/BalanceIntents.entitlements'),
      app,
    ], { stdio: 'inherit' })
    const request = randomUUID()
    await new Promise((resolve, reject) => {
      const receiver = spawn(sandboxed, ['--wait', request], { timeout: 10_000 })
      let output = ''
      let sent = false
      receiver.stdout.on('data', (chunk) => {
        output += chunk
        if (!sent && output.includes('READY')) {
          sent = true
          execFileSync(binary, ['--receipt', request], { timeout: 5_000 })
        }
      })
      receiver.stderr.pipe(process.stderr)
      receiver.on('error', reject)
      receiver.on('close', (code, signal) => {
        try {
          assert.equal(code, 0, `receiver exited: ${signal}; output: ${output}`)
          assert.ok(output.includes('SAVED'), 'sandboxed receiver confirmed the host receipt')
          resolve()
        } catch (error) { reject(error) }
      })
    })
  } finally {
    rmSync(temporary, { recursive: true, force: true })
  }
})
