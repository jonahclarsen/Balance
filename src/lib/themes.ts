export const THEME_PRESETS = [
  {
    id: 'forest',
    name: 'Forest',
    description: 'Teal and warm paper',
    swatches: ['#2f6f68', '#ebe7dc', '#3f9d54'],
    checkboxColor: '#2f6f68',
    doneColor: '#3f9d54',
  },
  {
    id: 'ocean',
    name: 'Ocean',
    description: 'Blue and cool mist',
    swatches: ['#276a9f', '#e7f0f6', '#278b9f'],
    checkboxColor: '#357fb5',
    doneColor: '#278b9f',
  },
  {
    id: 'violet',
    name: 'Violet',
    description: 'Purple and soft lilac',
    swatches: ['#7355a2', '#ece7f3', '#8a63b8'],
    checkboxColor: '#7c5aaa',
    doneColor: '#8a63b8',
  },
  {
    id: 'sunset',
    name: 'Sunset',
    description: 'Coral and warm sand',
    swatches: ['#b9563f', '#f1e4d9', '#c77832'],
    checkboxColor: '#c25d43',
    doneColor: '#c77832',
  },
  {
    id: 'berry',
    name: 'Berry',
    description: 'Rose and cool blush',
    swatches: ['#9b496b', '#f1e5ec', '#b45672'],
    checkboxColor: '#a75070',
    doneColor: '#b45672',
  },
] as const

export type ThemeId = (typeof THEME_PRESETS)[number]['id']

export const DEFAULT_THEME_ID: ThemeId = 'forest'
export const THEME_STORAGE_KEY = 'balance:colorTheme'

export function normalizeThemeId(value: string | null | undefined): ThemeId {
  return THEME_PRESETS.some((theme) => theme.id === value) ? (value as ThemeId) : DEFAULT_THEME_ID
}
