import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { DEFAULT_THEME_ID } from './lib/themes'
import { DEFAULT_INTERFACE_FONT_ID } from './lib/fonts'

document.documentElement.dataset.theme = DEFAULT_THEME_ID
document.documentElement.dataset.interfaceFont = DEFAULT_INTERFACE_FONT_ID

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
