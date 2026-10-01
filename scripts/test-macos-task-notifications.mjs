import { mkdtempSync, mkdirSync, existsSync, writeFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { execFileSync, spawn } from 'node:child_process'
import { createConnection } from 'node:net'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'

// No app database, permission prompt, or real notification is involved. Exercise
// the bridge as a bare executable, including Tauri's embedded-plist dev shape.
const directory = mkdtempSync('/tmp/balance-notification-dev-test-')
let helper
let helperClosed
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
  const app = join(directory, 'SyntheticBridge.app/Contents')
  mkdirSync(join(app, 'MacOS'), { recursive: true })
  writeFileSync(join(app, 'Info.plist'), `<?xml version="1.0"?><plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>app.balance.synthetic-notification-test</string>
<key>CFBundleExecutable</key><string>SyntheticBridge</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>LSBackgroundOnly</key><true/>
</dict></plist>`)
  const executable = join(app, 'MacOS/SyntheticBridge')
  execFileSync('xcrun', ['swiftc', '-parse-as-library', resolve('src-tauri/macos/BalanceWidgetDevBridge.swift'), resolve('src-tauri/macos/TaskNotificationBridge.swift'), '-o', executable], { stdio: 'inherit' })
  const ready = join(directory, 'ready')
  const socket = join(directory, 'notifications.sock')
  helper = spawn(executable, [String(process.pid), ready, socket], { stdio: 'inherit' })
  helperClosed = new Promise(resolve => helper.once('close', resolve))
  for (let attempt = 0; !existsSync(ready) && attempt < 100; attempt++) {
    assert.equal(helper.exitCode, null, 'Helper exited before becoming ready')
    await delay(50)
  }
  assert.ok(existsSync(ready), 'Helper socket became ready')
  async function send(json) {
    return new Promise((resolve, reject) => {
      const connection = createConnection(socket)
      connection.setTimeout(5_000, () => connection.destroy(new Error('Helper timed out')))
      connection.on('error', reject)
      connection.on('connect', () => connection.end(json))
      connection.on('data', data => { resolve(data[0]); connection.destroy() })
      connection.on('end', () => reject(new Error('Helper closed without acknowledgement')))
    })
  }
  assert.equal(await send('[]'), 0)
  assert.equal(await send('invalid-json'), 1)
  await delay(500)
  assert.equal(helper.exitCode, null, 'App-shaped helper acquired the macOS notification center without crashing')
  console.log('Dev helper received schedules through its private socket and acquired the notification center')
  // Exercise the native sender with its own supervised helper, as in tauri dev.
  const nativeReady = join(directory, 'native-ready')
  const nativeSocket = join(directory, 'native.sock')
  writeFileSync(main, `import Foundation
import Darwin
let helper = Process()
helper.executableURL = URL(fileURLWithPath: ${JSON.stringify(executable)})
helper.arguments = [String(getpid()), ${JSON.stringify(nativeReady)}, ${JSON.stringify(nativeSocket)}]
try helper.run()
defer { helper.terminate(); helper.waitUntilExit() }
for _ in 0..<100 {
    if FileManager.default.fileExists(atPath: ${JSON.stringify(nativeReady)}) { break }
    Thread.sleep(forTimeInterval: 0.05)
}
precondition(sendDevTaskNotifications("[]", path: ${JSON.stringify(nativeSocket)}))
setenv("BALANCE_DEV_NOTIFICATION_SOCKET", ${JSON.stringify(nativeSocket)}, 1)
precondition("[]".withCString { balanceReplaceTaskNotifications($0) } == 0)
Thread.sleep(forTimeInterval: 0.5)
precondition(helper.isRunning)
print("Native dev notification forwarding passed")
`)
  const sender = join(directory, 'native-sender')
  execFileSync('xcrun', ['swiftc', resolve('src-tauri/macos/TaskNotificationBridge.swift'), main, '-o', sender], { stdio: 'inherit' })
  execFileSync(sender, [], { stdio: 'inherit', timeout: 10_000 })
} finally {
  if (helper) {
    helper.kill()
    await helperClosed
  }
  rmSync(directory, { recursive: true, force: true })
}
