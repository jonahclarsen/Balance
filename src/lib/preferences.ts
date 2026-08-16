import { DEFAULT_INTERFACE_FONT_ID, normalizeInterfaceFontId } from './fonts'
import { DEFAULT_THEME_ID, normalizeThemeId } from './themes'
import type { ReplicatedPreferences } from './types'

export const DEFAULT_DATABASE_LOADING_MESSAGES = [
  'Good things come to those who briefly wait.',
  'Pretend this is an intentional mindfulness exercise.',
  'Fun fact: this message has no fun fact.',
]

export function createDefaultReplicatedPreferences(): ReplicatedPreferences {
  return {
    themeId: DEFAULT_THEME_ID,
    interfaceFontId: DEFAULT_INTERFACE_FONT_ID,
    doneTintColor: '',
    checkboxColor: '',
    databaseLoadingMessages: [...DEFAULT_DATABASE_LOADING_MESSAGES],
  }
}

function normalizeColorOverride(value: unknown): string {
  if (typeof value !== 'string') return ''
  const hex = value.trim().replace(/^#/, '')
  return /^[0-9a-fA-F]{6}$/.test(hex) ? `#${hex.toLowerCase()}` : ''
}

export function normalizeReplicatedPreferences(value: unknown): ReplicatedPreferences {
  const defaults = createDefaultReplicatedPreferences()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults

  const preferences = value as Partial<Record<keyof ReplicatedPreferences, unknown>>
  const databaseLoadingMessages = Array.isArray(preferences.databaseLoadingMessages)
    ? preferences.databaseLoadingMessages
      .filter((message): message is string => typeof message === 'string')
      .map((message) => message.trim())
      .filter(Boolean)
    : defaults.databaseLoadingMessages

  return {
    themeId: normalizeThemeId(typeof preferences.themeId === 'string' ? preferences.themeId : null),
    interfaceFontId: normalizeInterfaceFontId(
      typeof preferences.interfaceFontId === 'string' ? preferences.interfaceFontId : null,
    ),
    doneTintColor: normalizeColorOverride(preferences.doneTintColor),
    checkboxColor: normalizeColorOverride(preferences.checkboxColor),
    databaseLoadingMessages,
  }
}
