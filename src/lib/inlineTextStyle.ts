// Text-only CSS that can safely survive paste, persistence and editor changes.
// No positioning, resource URLs, custom properties or document-wide rules.
export function inlineTextStyle(value: string): string {
  if (!value || typeof document === 'undefined') return ''
  const source = document.createElement('span').style
  const output = document.createElement('span').style
  source.cssText = value
  const family = source.fontFamily
  if (family && /^[\w\s,'".-]+$/.test(family)) output.fontFamily = family
  const size = source.fontSize
  if (/^(?:\d+(?:\.\d+)?)(?:px|pt|em|rem|%)$/.test(size)) {
    const n = parseFloat(size)
    const max = size.endsWith('%') ? 400 : /(?:r?em)$/.test(size) ? 4 : 96
    if (n > 0 && n <= max) output.fontSize = size
  }
  if (/^(bold|[5-9]00)$/.test(source.fontWeight)) output.fontWeight = source.fontWeight
  if (/^(italic|oblique)$/.test(source.fontStyle)) output.fontStyle = source.fontStyle
  for (const property of ['color', 'background-color'] as const) {
    const color = source.getPropertyValue(property)
    if (color && /^(#[\da-f]{3,8}|[a-z]+|rgba?\([\d.,%\s]+\)|hsla?\([\d.,%\s]+\))$/i.test(color)) output.setProperty(property, color)
  }
  const decoration = source.textDecorationLine || source.textDecoration
  if (/^(underline|line-through|underline line-through|none)$/.test(decoration)) output.textDecorationLine = decoration
  return output.cssText
}
