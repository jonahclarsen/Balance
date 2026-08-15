import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { normalizeThemeId, THEME_STORAGE_KEY } from './lib/themes'

document.documentElement.dataset.theme = normalizeThemeId(localStorage.getItem(THEME_STORAGE_KEY))

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
