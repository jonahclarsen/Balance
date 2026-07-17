export type PickerColor = {
  hue: number
  lightness: number
}

export function normalizePickerHue(value: number): number {
  return ((Math.round(Number(value) || 0) % 360) + 360) % 360
}

export function normalizePickerLightness(value: number): number {
  return Math.max(0, Math.min(100, Math.round(Number(value) || 0)))
}

export function pickerColorToHex({ hue, lightness: lightnessControl }: PickerColor): string {
  const normalizedHue = normalizePickerHue(hue)
  const saturation = 0.58
  const lightness = Math.max(0, Math.min(1, 0.48 + (normalizePickerLightness(lightnessControl) - 50) / 200))
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
  const x = chroma * (1 - Math.abs(((normalizedHue / 60) % 2) - 1))
  const offset = lightness - chroma / 2
  const [red, green, blue] =
    normalizedHue < 60
      ? [chroma, x, 0]
      : normalizedHue < 120
        ? [x, chroma, 0]
        : normalizedHue < 180
          ? [0, chroma, x]
          : normalizedHue < 240
            ? [0, x, chroma]
            : normalizedHue < 300
              ? [x, 0, chroma]
              : [chroma, 0, x]

  return `#${[red, green, blue]
    .map((channel) => Math.round((channel + offset) * 255).toString(16).padStart(2, '0'))
    .join('')}`
}

export function hexToPickerColor(hex: string): PickerColor {
  const match = /^#?([0-9a-f]{6})$/i.exec(hex)
  if (!match) return { hue: 0, lightness: 50 }

  const value = match[1]
  const red = Number.parseInt(value.slice(0, 2), 16) / 255
  const green = Number.parseInt(value.slice(2, 4), 16) / 255
  const blue = Number.parseInt(value.slice(4, 6), 16) / 255
  const max = Math.max(red, green, blue)
  const min = Math.min(red, green, blue)
  const delta = max - min
  const hslLightness = (max + min) / 2
  let hue = 0

  if (delta !== 0) {
    const raw =
      max === red
        ? ((green - blue) / delta) % 6
        : max === green
          ? (blue - red) / delta + 2
          : (red - green) / delta + 4
    hue = normalizePickerHue(raw * 60)
  }

  return {
    hue,
    lightness: normalizePickerLightness((hslLightness - 0.48) * 200 + 50),
  }
}
