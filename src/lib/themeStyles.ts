import retro from '../retro-themes.css?inline'
import aeroLuna from '../aero-luna-themes.css?inline'
import windowsShell from '../windows-shell-themes.css?inline'

// Keep every historical theme renderable, but do not make unrelated themes
// match thousands of inactive chrome selectors on every focus or DOM move.
const groups = [
  { id: 'retro', themes: ['windows98', 'system1'], css: retro },
  { id: 'aero-luna', themes: ['windowsxp', 'windowsvista'], css: aeroLuna },
  { id: 'windows-shell', themes: ['windowsxp', 'windowsvista'], css: windowsShell },
]

export function applyThemeStyles(themeId: string) {
  for (const group of groups) {
    const enabled = group.themes.includes(themeId)
    let style = document.getElementById(`balance-theme-${group.id}`) as HTMLStyleElement | null
    if (!style && enabled) {
      style = document.createElement('style')
      style.id = `balance-theme-${group.id}`
      style.media = 'not all'
      document.head.append(style)
    }
    if (!style) continue
    if (style.textContent !== group.css) style.textContent = group.css
    const media = enabled ? 'all' : 'not all'
    if (style.media !== media) style.media = media
  }
  if (document.documentElement.dataset.theme !== themeId) document.documentElement.dataset.theme = themeId
}
