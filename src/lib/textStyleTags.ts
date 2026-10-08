// Pasted CSS never survives as styling: notes only have bold, italic and
// underline. Map an element's inline style onto those marks and drop the rest.
export function textStyleTags(element: HTMLElement): string[] {
  const { fontWeight, fontStyle, fontFamily } = element.style
  const decoration = element.style.textDecorationLine || element.style.textDecoration
  const tags: string[] = []
  if (/^(bold|bolder|[6-9]00)$/.test(fontWeight) || (!fontWeight && /bold|heavy|black/i.test(fontFamily))) tags.push('strong')
  if (/^(italic|oblique)/.test(fontStyle) || (!fontStyle && /italic|oblique/i.test(fontFamily))) tags.push('em')
  if (/underline/.test(decoration)) tags.push('u')
  return tags
}

// Google Docs wraps whole documents in <b style="font-weight: normal">.
export function isUnboldedBold(element: HTMLElement): boolean {
  return /^(normal|lighter|[1-5]00)$/.test(element.style.fontWeight)
}
