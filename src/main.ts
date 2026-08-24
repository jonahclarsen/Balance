import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { createDefaultDeviceAppearance, effectiveThemeForDate, readDeviceAppearanceBootstrap } from './lib/deviceAppearance'
import { todayISO } from './lib/planner'

const deviceThemeBootstrapStartedAt = performance.now()
const startupAppearance = readDeviceAppearanceBootstrap() ?? createDefaultDeviceAppearance()
document.documentElement.dataset.theme = effectiveThemeForDate(startupAppearance, todayISO())
performance.measure('balance-device-theme-bootstrap', {
  start: deviceThemeBootstrapStartedAt,
  end: performance.now(),
})

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
