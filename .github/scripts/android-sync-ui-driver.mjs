#!/usr/bin/env node
// Prepare the synthetic primary and activate camera/review controls through
// the real debug WebView. UI Automator coordinate taps can miss clipped controls.
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'

if (!process.env.CI) throw new Error('This synthetic Android fixture runs only in CI.')
const action = process.argv[2]
const profile = Number(process.env.BALANCE_UI_PROFILE ?? 0)
if (!Number.isInteger(profile) || profile < 0) throw new Error('Invalid synthetic profile.')
const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8', timeout: 15_000 }).trim()
const processRow = adb('shell', 'ps', '-A', '-o', 'UID,PID,NAME').split('\n').map((row) => row.trim().split(/\s+/))
  .find(([uid, , name]) => name === 'app.balance.local.debug' && Math.floor(Number(uid) / 100_000) === profile)
const pid = processRow?.[1]
if (!pid || !/^\d+$/.test(pid)) throw new Error('The synthetic profile app is not running.')
let expression
if (action === 'seed-source') {
  const relayUrl = process.env.BALANCE_UI_RELAY_URL
  if (!relayUrl || profile !== 0) throw new Error('The temporary source relay address is missing.')
  const pairingCode = (await readFile('sync-e2e-pairing-code.txt', 'utf8')).trim()
  expression = `(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    await invoke('sync_enable_primary', ${JSON.stringify({ pairingCode, relayUrl })});
    await invoke('sync_relay_once', { reason: 'ci-source-fixture' });
    setTimeout(() => location.reload(), 100);
    return true;
  })()`
} else if (action === 'click') {
  const label = process.argv[3]
  if (!['Scan QR code', 'Connect and replace this planner'].includes(label)) throw new Error('Unsupported test control.')
  expression = `(() => {
    const button = [...document.querySelectorAll('.sync-panel button')].find(button => button.textContent.trim() === ${JSON.stringify(label)});
    if (!button || button.disabled) throw new Error('Sync test control is missing or disabled.');
    button.scrollIntoView({ block: 'center' });
    button.click();
    return true;
  })()`
} else {
  throw new Error('Expected seed-source or click.')
}
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
        expression,
        awaitPromise: true, returnByValue: true,
      },
    }))
  })
  console.log(`[ui-sync] WebView action ${action} completed for synthetic profile ${profile}`)
} finally {
  socket?.close()
  adb('forward', '--remove', 'tcp:9224')
}
