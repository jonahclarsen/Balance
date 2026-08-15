export const INTERFACE_FONT_PRESETS = [
  {
    id: 'rounded',
    name: 'Rounded',
    description: 'Soft and approachable',
    preview: 'Balance your day',
    cssStack: 'ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", sans-serif',
  },
  {
    id: 'system',
    name: 'System',
    description: 'Clean and familiar',
    preview: 'Balance your day',
    cssStack: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  },
  {
    id: 'classic',
    name: 'Classic',
    description: 'Traditional and warm',
    preview: 'Balance your day',
    cssStack: 'Georgia, "Times New Roman", serif',
  },
  {
    id: 'geometric',
    name: 'Geometric',
    description: 'Crisp and modern',
    preview: 'Balance your day',
    cssStack: 'Futura, "Century Gothic", "Trebuchet MS", sans-serif',
  },
  {
    id: 'friendly',
    name: 'Friendly',
    description: 'Casual and welcoming',
    preview: 'Balance your day',
    cssStack: '"Trebuchet MS", Verdana, sans-serif',
  },
  {
    id: 'condensed',
    name: 'Condensed',
    description: 'Focused and space-saving',
    preview: 'Balance your day',
    cssStack: '"Avenir Next Condensed", "Arial Narrow", "Roboto Condensed", sans-serif',
  },
  {
    id: 'bookish',
    name: 'Bookish',
    description: 'Elegant and literary',
    preview: 'Balance your day',
    cssStack: 'Palatino, "Palatino Linotype", "Book Antiqua", serif',
  },
] as const

export type InterfaceFontId = (typeof INTERFACE_FONT_PRESETS)[number]['id']

export const DEFAULT_INTERFACE_FONT_ID: InterfaceFontId = 'rounded'

export const INTERFACE_FONT_STORAGE_KEY = 'balance:interfaceFont'

function normalizePresetId<TId extends string>(
  value: string | null | undefined,
  presets: readonly { id: TId }[],
  fallback: TId,
): TId {
  return presets.some((preset) => preset.id === value) ? (value as TId) : fallback
}

export function normalizeInterfaceFontId(value: string | null | undefined): InterfaceFontId {
  return normalizePresetId(value, INTERFACE_FONT_PRESETS, DEFAULT_INTERFACE_FONT_ID)
}
