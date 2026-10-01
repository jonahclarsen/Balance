import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { execFileSync } from 'node:child_process'

// No app database, permission prompt, or real notification is involved. Exercise
// the bridge as a bare executable, including Tauri's embedded-plist dev shape.
const directory = mkdtempSync(join(tmpdir(), 'balance-notification-dev-test-'))
try {
  const main = join(directory, 'main.swift')
  const plist = join(directory, 'Info.plist')
  writeFileSync(main, `import Foundation
let reminder = "[{\\"id\\":\\"synthetic\\",\\"at\\":4102444800000,\\"text\\":\\"Synthetic reminder\\"}]"
precondition(Bundle.main.bundleURL.pathExtension != "app")
precondition(reminder.withCString { balanceReplaceTaskNotifications($0) } == 0)
// Before the guard, the asynchronous notification-center lookup aborts here.
Thread.sleep(forTimeInterval: 0.5)
print("Unbundled notification bridge passed")
`)
  writeFileSync(plist, `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.balance.synthetic-notification-test</string>
<key>CFBundleName</key><string>BalanceSyntheticNotificationTest</string>
</dict></plist>`)
  for (const embedded of [false, true]) {
    const executable = join(directory, embedded ? 'embedded' : 'bare')
    const args = ['swiftc', resolve('src-tauri/macos/TaskNotificationBridge.swift'), main, '-o', executable]
    if (embedded) args.push('-Xlinker', '-sectcreate', '-Xlinker', '__TEXT', '-Xlinker', '__info_plist', '-Xlinker', plist)
    execFileSync('xcrun', args, { stdio: 'inherit' })
    execFileSync(executable, [], { stdio: 'inherit', timeout: 10_000 })
  }
} finally {
  rmSync(directory, { recursive: true, force: true })
}
