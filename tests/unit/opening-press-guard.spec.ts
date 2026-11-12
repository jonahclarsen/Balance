import { expect, test } from '@playwright/test'
import { ignoreOpeningPress } from '../../src/lib/openingPressGuard'

function surface() {
  const node = new EventTarget()
  const guard = ignoreOpeningPress(node as unknown as HTMLElement)
  const click = () => node.dispatchEvent(Object.assign(new Event('click', { cancelable: true }), {
    detail: 0, clientX: 200, clientY: 100,
  }))
  const keydown = (key: string, isComposing = false) => {
    node.dispatchEvent(Object.assign(new Event('keydown'), { key, isComposing }))
  }
  return { node, guard, click, keydown }
}

for (const key of ['Enter', ' ']) {
  test(`opening press guard accepts a WebKit click after ${JSON.stringify(key)}`, () => {
    const { guard, click, keydown } = surface()
    keydown(key)
    expect(click()).toBe(true)
    guard.update(false)
    guard.update(true)
    expect(click()).toBe(false)
    guard.destroy()
  })
}

test('opening press guard still blocks an Android zero-detail opening click', () => {
  const { node, guard, click, keydown } = surface()
  keydown('a')
  keydown('Enter', true)
  expect(click()).toBe(false)
  guard.update(false)
  guard.update(true)
  node.dispatchEvent(new Event('pointerdown'))
  expect(click()).toBe(true)
  guard.destroy()
})
