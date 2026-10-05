import test from 'node:test'
import assert from 'node:assert/strict'
import { createNetworkLossFixture } from './android-network-loss-fixture.mjs'

test('fault fixture proves healthy relay, accepted silent requests, reset and recovery', async () => {
  const fixture = await createNetworkLossFixture()
  const url = fixture.relayUrl.replace('10.0.2.2', '127.0.0.1') + 'v3/manifest'
  try {
    assert.equal((await fetch(url)).status, 200)
    const before = fixture.manifestRequests
    fixture.setMode('silent')
    const aborted = new AbortController()
    const request = fetch(url, {signal: aborted.signal}).then(() => false, () => true)
    const deadline = Date.now() + 3000
    while (fixture.manifestRequests === before && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.equal(fixture.manifestRequests, before + 1)
    const result = await Promise.race([request, new Promise(resolve => setTimeout(() => resolve('pending'), 100))])
    assert.equal(result, 'pending', 'silent fault must keep the real request pending')
    fixture.setMode('reset')
    assert.equal(await request, true, 'reset must cut the already accepted request')
    fixture.setMode('online')
    assert.equal((await fetch(url)).status, 200)
  } finally { await fixture.close() }
})
