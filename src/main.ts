import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import {
  applyIridescentHueShift,
  COLOR_SCHEME_QUERY,
  createDefaultDeviceAppearance,
  effectiveColorScheme,
  effectiveThemeForDate,
  readDeviceAppearanceBootstrap,
} from './lib/deviceAppearance'
import { todayISO } from './lib/planner'
import { installWebKitInnerHTMLWorkaround } from './lib/webkitInnerHTMLWorkaround'

installWebKitInnerHTMLWorkaround()

const deviceThemeBootstrapStartedAt = performance.now()
const startupAppearance = readDeviceAppearanceBootstrap() ?? createDefaultDeviceAppearance()
document.documentElement.dataset.colorScheme = effectiveColorScheme(
  startupAppearance.colorScheme,
  window.matchMedia(COLOR_SCHEME_QUERY).matches,
)
document.documentElement.dataset.theme = effectiveThemeForDate(startupAppearance, todayISO())
applyIridescentHueShift()
performance.measure('balance-device-theme-bootstrap', {
  start: deviceThemeBootstrapStartedAt,
  end: performance.now(),
})

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
