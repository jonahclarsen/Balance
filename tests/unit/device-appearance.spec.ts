import { expect, test } from '@playwright/test'
import {
  createDefaultDeviceAppearance,
  effectiveColorScheme,
  normalizeDeviceAppearance,
} from '../../src/lib/deviceAppearance'

test('older device appearance records default to the system color scheme', () => {
  expect(createDefaultDeviceAppearance().colorScheme).toBe('system')
  expect(normalizeDeviceAppearance({ version: 1, themeId: 'graphite' }).colorScheme).toBe('system')
  expect(normalizeDeviceAppearance({ colorScheme: 'unknown' }).colorScheme).toBe('system')
})

test('the selected color scheme overrides the system only when requested', () => {
  expect(effectiveColorScheme('system', false)).toBe('light')
  expect(effectiveColorScheme('system', true)).toBe('dark')
  expect(effectiveColorScheme('light', true)).toBe('light')
  expect(effectiveColorScheme('dark', false)).toBe('dark')
})
