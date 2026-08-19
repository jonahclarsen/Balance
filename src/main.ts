import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'
import { DEFAULT_THEME_ID } from './lib/themes'

document.documentElement.dataset.theme = DEFAULT_THEME_ID

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
