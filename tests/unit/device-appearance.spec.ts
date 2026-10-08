import { expect, test } from '@playwright/test'
import {
  createDefaultDeviceAppearance,
  effectiveColorScheme,
  normalizeDeviceAppearance,
  selectedColorSchemeForDate,
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

test('a scheduled return to the system scheme starts on its day', () => {
  const appearance = normalizeDeviceAppearance({ colorScheme: 'dark', systemColorSchemeStartDate: '2026-08-18' })
  expect(appearance.systemColorSchemeStartDate).toBe('2026-08-18')
  expect(selectedColorSchemeForDate(appearance, '2026-08-17')).toBe('dark')
  expect(selectedColorSchemeForDate(appearance, '2026-08-18')).toBe('system')
  expect(selectedColorSchemeForDate(appearance, '2026-08-19')).toBe('system')
  expect(normalizeDeviceAppearance({ colorScheme: 'dark', systemColorSchemeStartDate: 'soon' }).systemColorSchemeStartDate).toBe('')
  expect(selectedColorSchemeForDate(normalizeDeviceAppearance({ colorScheme: 'light' }), '2026-08-18')).toBe('light')
})
