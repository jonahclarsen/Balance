import assert from 'node:assert/strict'
import test from 'node:test'
import { cdpErrorMessage } from './cdp-error.mjs'

test('retains a native string rejection hidden by the generic CDP text', () => {
  assert.equal(cdpErrorMessage({ text: 'Uncaught (in promise)', exception: { type: 'string', value: 'sync-offline' } }), 'sync-offline')
})

test('redacts generated relay URLs and pairing codes from rejection diagnostics', () => {
  const message = cdpErrorMessage({ exception: { value: 'request failed at http://10.0.2.2:8791/synthetic-secret/ for BALSYNC1:synthetic-test-key' } })
  assert.equal(message, 'request failed at [redacted URL] for [redacted pairing code]')
})

test('preserves Error descriptions and bounds the captured message', () => {
  assert.equal(cdpErrorMessage({ text: 'Uncaught', exception: { description: 'TypeError: synthetic failure' } }), 'TypeError: synthetic failure')
  assert.equal(cdpErrorMessage({ exception: { value: 'x'.repeat(2000) } }).length, 1000)
})
