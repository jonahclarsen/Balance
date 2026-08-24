// Historical day records persist theme IDs forever. Never delete an entry,
// rename its ID, or remove its CSS/native palettes. Retire a theme by setting
// `retired: true`; that hides it from current selection and Random mode while
// keeping old days renderable. See the balance-themes skill.
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
    id: 'crimson',
    name: 'Crimson',
    description: 'Rich red and soft ivory',
    swatches: ['#a92f42', '#f2e2e5', '#bd4051'],
    checkboxColor: '#bd4051',
    doneColor: '#a94552',
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
    id: 'orange',
    name: 'Orange',
    description: 'Clear orange and light apricot',
    swatches: ['#b96f25', '#f2e7d8', '#c9893e'],
    checkboxColor: '#b96f25',
    doneColor: '#c9893e',
  },
  {
    id: 'earth',
    name: 'Earth',
    description: 'Weathered wood and quiet soil',
    swatches: ['#796451', '#ebe5dc', '#91806d'],
    checkboxColor: '#796451',
    doneColor: '#91806d',
  },
  {
    id: 'banana',
    name: 'Banana',
    description: 'Soft ochre and mellow cream',
    swatches: ['#827136', '#eeeadd', '#b1a36e'],
    checkboxColor: '#827136',
    doneColor: '#918149',
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
    id: 'midnight',
    name: 'Midnight',
    description: 'Indigo and cool moonlight',
    swatches: ['#425b9b', '#e4e8f3', '#596fbb'],
    checkboxColor: '#526bb0',
    doneColor: '#596fbb',
  },
  {
    id: 'violet',
    name: 'Violet',
    description: 'Purple and soft lilac',
    swatches: ['#7355a2', '#ece7f3', '#8a63b8'],
    checkboxColor: '#7c5aaa',
    doneColor: '#8a63b8',
  },
] as const

export type PresetThemeId = (typeof THEME_PRESETS)[number]['id']
export type ThemeId = 'random' | PresetThemeId

export const DEFAULT_THEME_ID: ThemeId = 'random'
export const DEFAULT_PRESET_THEME_ID: PresetThemeId = 'iridescent'

export const ACTIVE_THEME_PRESETS = THEME_PRESETS.filter(
  (theme) => !('retired' in theme && theme.retired === true),
)

export const THEME_OPTIONS = [
  {
    id: 'random',
    name: 'Random',
    description: 'A different theme every day',
    swatches: [
      'linear-gradient(135deg, #f24c9f, #9b62dd 48%, #39c5d6)',
      'linear-gradient(135deg, #287968, #276a9f)',
      'linear-gradient(135deg, #c33f7a, #425b9b)',
    ],
  },
  ...ACTIVE_THEME_PRESETS,
] as const

export function normalizeThemeId(value: string | null | undefined): ThemeId {
  if (value === 'berry') return 'banana'
  return value === 'random' || ACTIVE_THEME_PRESETS.some((theme) => theme.id === value)
    ? (value as ThemeId)
    : DEFAULT_THEME_ID
}

export function normalizePresetThemeId(value: string | null | undefined): PresetThemeId {
  if (value === 'berry') return 'banana'
  return THEME_PRESETS.some((theme) => theme.id === value)
    ? (value as PresetThemeId)
    : DEFAULT_PRESET_THEME_ID
}

const MASK_64 = 0xffff_ffff_ffff_ffffn
const FNV_OFFSET_64 = 0xcbf2_9ce4_8422_2325n
const FNV_PRIME_64 = 0x0000_0100_0000_01b3n
const MIX_MULTIPLIER_1 = 0xff51_afd7_ed55_8ccdn
const MIX_MULTIPLIER_2 = 0xc4ce_b9fe_1a85_ec53n
const RANDOM_THEME_HASH_NAMESPACE = 'balance-random-v1\0'

/**
 * Stable synchronous 64-bit FNV-1a plus a Murmur-style avalanche. Do not swap
 * this for a platform hash: startup TypeScript and native Rust widgets must
 * keep producing the exact same scores. Golden vectors protect the contract.
 */
export function stableThemeHash64(value: string): bigint {
  let hash = FNV_OFFSET_64
  for (const byte of new TextEncoder().encode(value)) {
    hash ^= BigInt(byte)
    hash = (hash * FNV_PRIME_64) & MASK_64
  }
  hash ^= hash >> 33n
  hash = (hash * MIX_MULTIPLIER_1) & MASK_64
  hash ^= hash >> 33n
  hash = (hash * MIX_MULTIPLIER_2) & MASK_64
  hash ^= hash >> 33n
  return hash & MASK_64
}

/**
 * Equal-weight rendezvous hashing: every active theme has a 1/N chance for a
 * date, catalog order is irrelevant, and adding/removing one theme remaps only
 * dates won by that theme. Independent daily choices may legitimately repeat.
 */
export function randomThemeForDate(
  date: string,
  themeIds: readonly PresetThemeId[] = ACTIVE_THEME_PRESETS.map((theme) => theme.id),
): PresetThemeId {
  let winner = DEFAULT_PRESET_THEME_ID
  let winningScore = -1n
  for (const themeId of themeIds) {
    const score = stableThemeHash64(`${RANDOM_THEME_HASH_NAMESPACE}${date}\0${themeId}`)
    if (score > winningScore || (score === winningScore && themeId > winner)) {
      winner = themeId
      winningScore = score
    }
  }
  return winner
}
