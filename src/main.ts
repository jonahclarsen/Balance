import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { normalizeThemeId, THEME_STORAGE_KEY } from './lib/themes'
import { INTERFACE_FONT_STORAGE_KEY, normalizeInterfaceFontId } from './lib/fonts'

document.documentElement.dataset.theme = normalizeThemeId(localStorage.getItem(THEME_STORAGE_KEY))
document.documentElement.dataset.interfaceFont = normalizeInterfaceFontId(localStorage.getItem(INTERFACE_FONT_STORAGE_KEY))

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
