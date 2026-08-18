export const THEME_PRESETS = [
  {
    id: 'iridescent',
    name: 'Iridescent',
    description: 'Prismatic pink, violet, aqua, and gold',
    swatches: [
      'linear-gradient(135deg, #f24c9f, #9b62dd 48%, #39c5d6)',
      'linear-gradient(135deg, #39c5d6, #46b887)',
      'linear-gradient(135deg, #46b887, #f0a23e)',
    ],
    checkboxColor: '#7b5bd6',
    doneColor: '#28a987',
  },
  {
    id: 'graphite',
    name: 'Graphite',
    description: 'Charcoal, silver, and clean gray',
    swatches: ['#252525', '#dededb', '#777774'],
    checkboxColor: '#303030',
    doneColor: '#777774',
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
  {
    id: 'pink',
    name: 'Pink',
    description: 'Bright pink and petal white',
    swatches: ['#c33f7a', '#f5e0ea', '#e16491'],
    checkboxColor: '#d34f89',
    doneColor: '#e16491',
  },
  {
    id: 'mint',
    name: 'Mint',
    description: 'Fresh green and pale mint',
    swatches: ['#287968', '#dff0e9', '#42a878'],
    checkboxColor: '#348b74',
    doneColor: '#42a878',
  },
  {
    id: 'midnight',
    name: 'Midnight',
    description: 'Indigo and cool moonlight',
    swatches: ['#425b9b', '#e4e8f3', '#596fbb'],
    checkboxColor: '#526bb0',
    doneColor: '#596fbb',
  },
] as const

export type ThemeId = (typeof THEME_PRESETS)[number]['id']

export const DEFAULT_THEME_ID: ThemeId = 'iridescent'

export function normalizeThemeId(value: string | null | undefined): ThemeId {
  return THEME_PRESETS.some((theme) => theme.id === value) ? (value as ThemeId) : DEFAULT_THEME_ID
}
