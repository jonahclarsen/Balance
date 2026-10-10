import { expect, test } from '@playwright/test'
import { startListStorageMaintenance } from '../../src/lib/listStorageMaintenance'

test('storage maintenance waits for idle, pauses when hidden, avoids overlap and cleans up', async () => {
  let now = 0
  let visible = true
  let ready = true
  let calls = 0
  let tick = () => {}
  let activity = () => {}
  let cleared = false
  let unlistened = false
  let finish: (result: { more: boolean }) => void = () => {}
  const stop = startListStorageMaintenance(() => {
    calls++
    return new Promise((resolve) => { finish = resolve })
  }, () => ready, {
    now: () => now, visible: () => visible,
    every: (callback) => { tick = callback; return 1 },
    clear: () => { cleared = true },
    activity: (callback) => { activity = callback; return () => { unlistened = true } },
  })
  now = 10_000
  activity()
  tick()
  expect(calls).toBe(0)
  now = 15_000
  visible = false
  tick()
  expect(calls).toBe(0)
  visible = true
  ready = false
  tick()
  expect(calls).toBe(0)
  ready = true
  tick()
  tick()
  expect(calls).toBe(1)
  finish({ more: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  now += 5_000
  tick()
  expect(calls).toBe(2)
  finish({ more: false })
  await new Promise((resolve) => setTimeout(resolve, 0))
  now += 60_000
  tick()
  expect(calls).toBe(2)
  now += 6 * 60 * 60 * 1000
  tick()
  expect(calls).toBe(3)
  stop()
  finish({ more: true })
  await new Promise((resolve) => setTimeout(resolve, 0))
  now += 10_000
  tick()
  expect(calls).toBe(3)
  expect(cleared && unlistened).toBe(true)
})
