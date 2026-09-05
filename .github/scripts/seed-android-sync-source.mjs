#!/usr/bin/env node
// Give the camera journey a real primary snapshot with its known test QR key.
// This only targets the fresh debug installation created by android-smoke-test.sh.
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

if (!process.env.CI) throw new Error('This synthetic Android fixture runs only in CI.')
const relayUrl = process.env.BALANCE_UI_RELAY_URL
if (!relayUrl) throw new Error('The temporary test relay address is missing.')
const pairingCode = (await readFile('sync-e2e-pairing-code.txt', 'utf8')).trim()
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 15_000 }).trim()
const pid = adb('shell', 'pidof', 'app.balance.local.debug').split(/\s+/)[0]
if (!/^\d+$/.test(pid)) throw new Error('The synthetic source app is not running.')
adb('forward', 'tcp:9224', `localabstract:webview_devtools_remote_${pid}`)
let socket
try {
  const response = await fetch('http://127.0.0.1:9224/json/list', { signal: AbortSignal.timeout(10_000) })
  const targets = await response.json()
  const target = targets.find((entry) => entry.type === 'page' && entry.webSocketDebuggerUrl)
  if (!target) throw new Error('The synthetic source WebView is unavailable.')
  socket = new WebSocket(target.webSocketDebuggerUrl.replace('localhost:9224', '127.0.0.1:9224'))
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('WebView connection timed out.')), 10_000)
    socket.addEventListener('open', () => { clearTimeout(timeout); resolve() }, { once: true })
    socket.addEventListener('error', () => { clearTimeout(timeout); reject(new Error('WebView connection failed.')) }, { once: true })
  })
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic source setup timed out.')), 30_000)
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data))
      if (message.id !== 1) return
      clearTimeout(timeout)
      const failure = message.error ?? message.result?.exceptionDetails
      if (failure) reject(new Error(JSON.stringify(failure)))
      else resolve()
    })
    socket.send(JSON.stringify({
      id: 1, method: 'Runtime.evaluate', params: {
        expression: `(async () => {
          const invoke = window.__TAURI_INTERNALS__.invoke;
          await invoke('sync_enable_primary', ${JSON.stringify({ pairingCode, relayUrl })});
          await invoke('sync_relay_once', { reason: 'ci-source-fixture' });
          setTimeout(() => location.reload(), 100);
          return true;
        })()`,
        awaitPromise: true, returnByValue: true,
      },
    }))
  })
  console.log('[ui-sync] synthetic primary snapshot uploaded to the test relay')
} finally {
  socket?.close()
  adb('forward', '--remove', 'tcp:9224')
}
