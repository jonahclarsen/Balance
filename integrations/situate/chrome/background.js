import { effectiveStatus, blockedBy } from './policy.js'
let snapshot
let pending
async function status() {
  if (!pending) pending = chrome.runtime.sendNativeMessage('app.balance.situate', { type:'status' })
    .then(async value => { if(value.version !== 1) throw new Error('Invalid status'); snapshot=value; await chrome.storage.local.set({ situate:value }); return value })
    .catch(async () => { snapshot ??= (await chrome.storage.local.get('situate')).situate; return snapshot })
    .finally(() => { pending=null })
  return effectiveStatus(await pending)
}
chrome.runtime.onMessage.addListener((message,sender,reply) => {
  if (message.type === 'status' && !sender.tab) { status().then(s => reply(s ?? { error:'Open Balance and install the Situate native host.' })); return true }
  if (message.type !== 'check' || !sender.tab || !sender.url) return false
  // Only the sender's own browser-provided URL is inspected, never an arbitrary URL from a page.
  status().then(s => reply({ blocked:blockedBy(s,sender.url), stale:!!s?.stale, ready:!!s }))
  return true
})
