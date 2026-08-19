import { DEFAULT_THEME_ID, normalizeThemeId } from './themes'
import type { IridescentGradientColor, IridescentGradientPreferences, ReplicatedPreferences } from './types'

export const DEFAULT_DATABASE_LOADING_MESSAGES = [
  'Good things come to those who briefly wait.',
  'Pretend this is an intentional mindfulness exercise.',
  'Fun fact: this message has no fun fact.',
]

export const DEFAULT_IRIDESCENT_GRADIENT: IridescentGradientPreferences = {
  contrast: 100,
  backgroundSaturation: 100,
  backgroundLightness: 0,
  angle: 145,
  reach: 34,
  colors: [
    { hue: 330, saturation: 85, lightness: 62, strength: 13 },
    { hue: 187, saturation: 65, lightness: 53, strength: 14 },
    { hue: 34, saturation: 86, lightness: 59, strength: 13 },
  ],
}

export function createDefaultIridescentGradient(): IridescentGradientPreferences {
  return {
    ...DEFAULT_IRIDESCENT_GRADIENT,
    colors: DEFAULT_IRIDESCENT_GRADIENT.colors.map((color) => ({ ...color })) as IridescentGradientPreferences['colors'],
  }
}

export function createDefaultReplicatedPreferences(): ReplicatedPreferences {
  return {
    themeId: DEFAULT_THEME_ID,
    doneTintColor: '',
    checkboxColor: '',
    databaseLoadingMessages: [...DEFAULT_DATABASE_LOADING_MESSAGES],
    iridescentGradient: createDefaultIridescentGradient(),
  }
}

function normalizeNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? Math.max(min, Math.min(max, Math.round(value)))
    : fallback
}

function normalizeIridescentColor(value: unknown, fallback: IridescentGradientColor): IridescentGradientColor {
  const color = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<Record<keyof IridescentGradientColor, unknown>>
    : {}
  return {
    hue: normalizeNumber(color.hue, fallback.hue, 0, 360),
    saturation: normalizeNumber(color.saturation, fallback.saturation, 0, 100),
    lightness: normalizeNumber(color.lightness, fallback.lightness, 0, 100),
    strength: normalizeNumber(color.strength, fallback.strength, 0, 40),
  }
}

export function normalizeIridescentGradient(value: unknown): IridescentGradientPreferences {
  const defaults = createDefaultIridescentGradient()
  const gradient = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Partial<Record<keyof IridescentGradientPreferences, unknown>>
    : {}
  const colors = Array.isArray(gradient.colors) ? gradient.colors : []
  return {
    contrast: normalizeNumber(gradient.contrast, defaults.contrast, 0, 250),
    backgroundSaturation: normalizeNumber(gradient.backgroundSaturation, defaults.backgroundSaturation, 0, 200),
    backgroundLightness: normalizeNumber(gradient.backgroundLightness, defaults.backgroundLightness, -12, 12),
    angle: normalizeNumber(gradient.angle, defaults.angle, 0, 360),
    reach: normalizeNumber(gradient.reach, defaults.reach, 16, 70),
    colors: defaults.colors.map((fallback, index) =>
      normalizeIridescentColor(colors[index], fallback)) as IridescentGradientPreferences['colors'],
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
    doneTintColor: normalizeColorOverride(preferences.doneTintColor),
    checkboxColor: normalizeColorOverride(preferences.checkboxColor),
    databaseLoadingMessages,
    iridescentGradient: normalizeIridescentGradient(preferences.iridescentGradient),
  }
}
