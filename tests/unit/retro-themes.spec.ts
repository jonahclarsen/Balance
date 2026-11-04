import { expect, test } from '@playwright/test'
import { normalizeReplicatedPreferences, replicatedDayTheme } from '../../src/lib/preferences'
import { ACTIVE_THEME_PRESETS, THEME_OPTIONS, DEFAULT_PRESET_THEME_ID, normalizePresetThemeId, randomThemeForDate } from '../../src/lib/themes'

test('new presets only remap Random dates they win', () => {
  const original = ACTIVE_THEME_PRESETS.map(theme => theme.id).filter(id => id !== 'windows98' && id !== 'system1' && id !== 'windowsxp' && id !== 'windowsvista')
  for (let day = 1; day <= 28; day++) {
    const date = `2026-10-${String(day).padStart(2, '0')}`
    const before = randomThemeForDate(date, original)
    const after = randomThemeForDate(date)
    expect([before, 'system1', 'windowsxp', 'windowsvista']).toContain(after)
  }
})

test('saved day themes retain old, retro, and unknown future IDs', () => {
  for (const id of ['graphite', 'windows98', 'system1', 'windowsxp', 'windowsvista', 'future-theme']) {
    const normalized = normalizeReplicatedPreferences({ 'dayTheme/2026-10-14': id })
    const stored = replicatedDayTheme(normalized, '2026-10-14')
    expect(stored).toBe(id)
    expect(normalizePresetThemeId(stored)).toBe(id === 'future-theme' ? DEFAULT_PRESET_THEME_ID : id)
  }
})

test('retired Windows 98 stays available to saved days but leaves the picker and Random', () => {
  expect(THEME_OPTIONS.some(theme => theme.id === 'windows98')).toBe(false)
  expect(ACTIVE_THEME_PRESETS.some(theme => theme.id === 'windows98')).toBe(false)
  expect(normalizePresetThemeId('windows98')).toBe('windows98')
})
