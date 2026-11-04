import { expect, test } from '@playwright/test'
import { normalizeReplicatedPreferences, replicatedDayTheme } from '../../src/lib/preferences'
import { ACTIVE_THEME_PRESETS, DEFAULT_PRESET_THEME_ID, normalizePresetThemeId, randomThemeForDate } from '../../src/lib/themes'

test('new presets only remap Random dates they win', () => {
  const original = ACTIVE_THEME_PRESETS.map(theme => theme.id).filter(id => id !== 'windows98' && id !== 'system1')
  for (let day = 1; day <= 28; day++) {
    const date = `2026-10-${String(day).padStart(2, '0')}`
    const before = randomThemeForDate(date, original)
    const after = randomThemeForDate(date)
    expect([before, 'windows98', 'system1']).toContain(after)
  }
})

test('saved day themes retain old, retro, and unknown future IDs', () => {
  for (const id of ['graphite', 'windows98', 'system1', 'future-theme']) {
    const normalized = normalizeReplicatedPreferences({ 'dayTheme/2026-10-14': id })
    const stored = replicatedDayTheme(normalized, '2026-10-14')
    expect(stored).toBe(id)
    expect(normalizePresetThemeId(stored)).toBe(id === 'future-theme' ? DEFAULT_PRESET_THEME_ID : id)
  }
})
