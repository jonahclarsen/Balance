import { invoke, isTauri } from '@tauri-apps/api/core'
import {
  createDefaultIridescentGradient,
  normalizeColorOverride,
  normalizeIridescentGradient,
} from './preferences'
import {
  DEFAULT_THEME_ID,
  normalizeThemeId,
  randomThemeForDate,
  type PresetThemeId,
  type ThemeId,
} from './themes'
import type { ColorSchemePreference, DeviceAppearancePreferences, ReplicatedPreferences } from './types'

// This deliberately contains appearance data only. It is the sole state needed
// before SQLCipher opens, so the loading screen can render the device's theme
// without exposing planner content or historical day-theme records.
export const DEVICE_APPEARANCE_BOOTSTRAP_KEY = 'balance:deviceAppearance.v1'
export const COLOR_SCHEME_QUERY = '(prefers-color-scheme: dark)'

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/

export function createDefaultDeviceAppearance(): DeviceAppearancePreferences {
  return {
    version: 1,
    colorScheme: 'system',
    themeId: DEFAULT_THEME_ID,
    randomThemeStartDate: '',
    doneTintColor: '',
    checkboxColor: '',
    iridescentGradient: createDefaultIridescentGradient(),
  }
}

export function normalizeDeviceAppearance(value: unknown): DeviceAppearancePreferences {
  const defaults = createDefaultDeviceAppearance()
  if (!value || typeof value !== 'object' || Array.isArray(value)) return defaults
  const appearance = value as Record<string, unknown>
  return {
    version: 1,
    colorScheme: normalizeColorScheme(appearance.colorScheme),
    themeId: normalizeThemeId(typeof appearance.themeId === 'string' ? appearance.themeId : null),
    randomThemeStartDate: typeof appearance.randomThemeStartDate === 'string'
      && DATE_PATTERN.test(appearance.randomThemeStartDate)
      ? appearance.randomThemeStartDate
      : '',
    doneTintColor: normalizeColorOverride(appearance.doneTintColor),
    checkboxColor: normalizeColorOverride(appearance.checkboxColor),
    iridescentGradient: normalizeIridescentGradient(appearance.iridescentGradient),
  }
}

export function normalizeColorScheme(value: unknown): ColorSchemePreference {
  return value === 'light' || value === 'dark' ? value : 'system'
}

export function effectiveColorScheme(
  preference: ColorSchemePreference,
  systemPrefersDark: boolean,
): 'light' | 'dark' {
  return preference === 'system' ? (systemPrefersDark ? 'dark' : 'light') : preference
}

export function deviceAppearanceFromLegacyPreferences(
  preferences: ReplicatedPreferences,
): DeviceAppearancePreferences {
  return normalizeDeviceAppearance({
    version: 1,
    themeId: preferences.themeId,
    randomThemeStartDate: preferences.randomThemeStartDate,
    doneTintColor: preferences.doneTintColor,
    checkboxColor: preferences.checkboxColor,
    iridescentGradient: preferences.iridescentGradient,
  })
}

export function readDeviceAppearanceBootstrap(
  storage: Pick<Storage, 'getItem'> = localStorage,
): DeviceAppearancePreferences | null {
  try {
    const raw = storage.getItem(DEVICE_APPEARANCE_BOOTSTRAP_KEY)
    return raw ? normalizeDeviceAppearance(JSON.parse(raw)) : null
  } catch {
    return null
  }
}

export function writeDeviceAppearanceBootstrap(
  appearance: DeviceAppearancePreferences,
  storage: Pick<Storage, 'setItem'> = localStorage,
): void {
  try {
    storage.setItem(DEVICE_APPEARANCE_BOOTSTRAP_KEY, JSON.stringify(normalizeDeviceAppearance(appearance)))
  } catch {
    // A denied storage write only means the next launch uses the safe fallback.
  }
}

export function selectedThemeForDate(appearance: DeviceAppearancePreferences, date: string): ThemeId {
  return appearance.randomThemeStartDate && appearance.randomThemeStartDate <= date
    ? 'random'
    : normalizeThemeId(appearance.themeId)
}

export function effectiveThemeForDate(
  appearance: DeviceAppearancePreferences,
  date: string,
): PresetThemeId {
  const selected = selectedThemeForDate(appearance, date)
  return selected === 'random' ? randomThemeForDate(date) : selected
}

export async function readEncryptedDeviceAppearance(): Promise<DeviceAppearancePreferences | null> {
  if (!isTauri()) return null
  const value = await invoke<unknown | null>('get_device_appearance')
  return value ? normalizeDeviceAppearance(value) : null
}

const ENCRYPTED_APPEARANCE_DEBOUNCE_MS = 250

let encryptedWriteQueue = Promise.resolve()
let encryptedWriteTimer: ReturnType<typeof setTimeout> | null = null
let pendingEncryptedAppearance: DeviceAppearancePreferences | null = null
let pendingEncryptedWaiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []

function flushEncryptedDeviceAppearance(): void {
  encryptedWriteTimer = null
  const appearance = pendingEncryptedAppearance
  const waiters = pendingEncryptedWaiters
  pendingEncryptedAppearance = null
  pendingEncryptedWaiters = []
  if (!appearance) {
    for (const waiter of waiters) waiter.resolve()
    return
  }

  encryptedWriteQueue = encryptedWriteQueue
    .catch(() => undefined)
    .then(() => invoke('set_device_appearance', { appearance }))
  void encryptedWriteQueue.then(
    () => waiters.forEach((waiter) => waiter.resolve()),
    (error) => waiters.forEach((waiter) => waiter.reject(error)),
  )
}

export function persistEncryptedDeviceAppearance(appearance: DeviceAppearancePreferences): Promise<void> {
  if (!isTauri()) return Promise.resolve()
  pendingEncryptedAppearance = normalizeDeviceAppearance(appearance)
  if (encryptedWriteTimer !== null) clearTimeout(encryptedWriteTimer)
  encryptedWriteTimer = setTimeout(flushEncryptedDeviceAppearance, ENCRYPTED_APPEARANCE_DEBOUNCE_MS)
  return new Promise<void>((resolve, reject) => pendingEncryptedWaiters.push({ resolve, reject }))
}
