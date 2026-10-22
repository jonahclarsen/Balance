import {
  DEFAULT_PRESET_THEME_ID,
  DEFAULT_THEME_ID,
  normalizePresetThemeId,
  normalizeThemeId,
} from './themes'
import { DEFAULT_COMPLETION_CELEBRATION_ID, normalizeCompletionCelebrationId } from './celebrations'
import type { ReplicatedPreferences } from './types'

export const DAY_THEME_PREFERENCE_PREFIX = 'dayTheme/'
const DAY_THEME_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function dayThemePreferenceKey(date: string): string {
  return `${DAY_THEME_PREFERENCE_PREFIX}${date}`
}

export function replicatedDayTheme(preferences: ReplicatedPreferences, date: string): string | null {
  const value = (preferences as unknown as Record<string, unknown>)[dayThemePreferenceKey(date)]
  return typeof value === 'string' && value.length > 0 ? value : null
}

export const DEFAULT_DATABASE_LOADING_MESSAGES = [
  'Good things come to those who briefly wait.',
  'Pretend this is an intentional mindfulness exercise.',
  'Fun fact: this message has no fun fact.',
]

export function createDefaultReplicatedPreferences(): ReplicatedPreferences {
  return {
    themeId: DEFAULT_THEME_ID,
    randomThemeId: DEFAULT_PRESET_THEME_ID,
    randomThemeDate: '',
    randomThemeStartDate: '',
    completionCelebrationId: DEFAULT_COMPLETION_CELEBRATION_ID,
    doneTintColor: '',
    checkboxColor: '',
    databaseLoadingMessages: [...DEFAULT_DATABASE_LOADING_MESSAGES],
  }
}

export function normalizeColorOverride(value: unknown): string {
  if (typeof value !== 'string') return ''
  const hex = value.trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : ''
}

export function normalizeReplicatedPreferences(value: unknown): ReplicatedPreferences {
  const defaults = createDefaultReplicatedPreferences()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults

  const preferences = value as Record<string, unknown>
  const databaseLoadingMessages = Array.isArray(preferences.databaseLoadingMessages)
    ? preferences.databaseLoadingMessages
      .filter((message): message is string => typeof message === 'string')
      .map((message) => message.trim())
      .filter(Boolean)
    : defaults.databaseLoadingMessages

  const dayThemes = Object.fromEntries(
    Object.entries(preferences).filter(([key, themeId]) =>
      key.startsWith(DAY_THEME_PREFERENCE_PREFIX)
      && DAY_THEME_DATE_PATTERN.test(key.slice(DAY_THEME_PREFERENCE_PREFIX.length))
      && typeof themeId === 'string'
      && themeId.length > 0,
    ),
  )

  return {
    // Per-date keys are independent replicated registers. Preserve unknown
    // future theme IDs verbatim so older clients cannot erase history they do
    // not yet know how to render.
    ...dayThemes,
    themeId: normalizeThemeId(typeof preferences.themeId === 'string' ? preferences.themeId : null),
    randomThemeId: normalizePresetThemeId(
      typeof preferences.randomThemeId === 'string' ? preferences.randomThemeId : null,
    ),
    randomThemeDate: typeof preferences.randomThemeDate === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(preferences.randomThemeDate)
      ? preferences.randomThemeDate
      : '',
    randomThemeStartDate: typeof preferences.randomThemeStartDate === 'string'
      && /^\d{4}-\d{2}-\d{2}$/.test(preferences.randomThemeStartDate)
      ? preferences.randomThemeStartDate
      : '',
    completionCelebrationId: normalizeCompletionCelebrationId(preferences.completionCelebrationId),
    doneTintColor: normalizeColorOverride(preferences.doneTintColor),
    checkboxColor: normalizeColorOverride(preferences.checkboxColor),
    databaseLoadingMessages,
  }
}
