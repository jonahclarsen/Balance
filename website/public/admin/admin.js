import {
  CATEGORIES, FONTS, ROLES, findFont, fontCssUrl, fontFamilies, fullFamilySpec, isGoogle,
  nearestWeight, overrideCss, resolveRole, sanitizeSettings, stack, weightOptions,
} from './fonts.js'

const $ = (id) => document.getElementById(id)
const frame = $('preview')
const state = { saved: {}, draft: {}, role: 'heading', category: 'all', query: '', page: '/', highlight: null }
// Preview copy, refreshed from the homepage so it tracks the real wording.
const copy = { hero: 'Plan your day and track your goals at the same time.', lede: 'A daily planner for Mac and Android.' }

const roleById = (id) => ROLES.find((role) => role.id === id)
const describe = ({ font, weight }) => `${font.family} ${weight}`
const dirty = () => JSON.stringify(sanitizeSettings(state.draft)) !== JSON.stringify(state.saved)

function setStatus(text, error = false) {
  $('status').textContent = text
  $('status').classList.toggle('error', error)
}

function element(tag, props = {}, children = []) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children)
  return node
}

// Every catalog font is declared up front; browsers only fetch the files a
// preview actually renders.
function loadCatalogFonts() {
  const specs = FONTS.filter(isGoogle).map(fullFamilySpec)
  for (let index = 0; index < specs.length; index += 8) {
    document.head.append(element('link', { rel: 'stylesheet', href: fontCssUrl(specs.slice(index, index + 8)) }))
  }
}

// CSS variables for each role's resolved font, used by the context previews.
function contextVars(settings) {
  const vars = {}
  for (const role of ROLES) {
    const { font, weight } = resolveRole(settings, role.id)
    vars[`--f-${role.id}`] = stack(font)
    vars[`--w-${role.id}`] = weight
  }
  return vars
}

function applyVars(node, vars) {
  for (const [name, value] of Object.entries(vars)) node.style.setProperty(name, value)
}

// The candidate settings a font button stands for: this role set to that font,
// keeping the current weight where the font has it.
function withChoice(roleId, family) {
  const next = { ...state.draft }
  if (!family) {
    delete next[roleId]
    return next
  }
  const font = findFont(family)
  next[roleId] = { family, weight: nearestWeight(font, resolveRole(state.draft, roleId).weight) }
  return next
}

const CONTEXTS = {
  heading: () => [element('span', { className: 'h', textContent: 'Goals that count themselves' }), element('span', { className: 'muted', textContent: 'Check things off as you go and every goal keeps score.' })],
  hero: () => [element('span', { className: 'h', textContent: copy.hero }), element('span', { className: 'muted', textContent: copy.lede })],
  wordmark: () => [element('img', { src: '/assets/logo.png', alt: '' }), element('span', { className: 'h', textContent: 'Balance' }), element('nav', {}, [element('span', { textContent: 'Docs' }), element('span', { textContent: 'GitHub' })])],
  body: () => [element('p', {}, ['Check things off as you go and Balance keeps score. ', element('strong', { textContent: 'Goals fill in on their own' }), ', day by day, so you can see the rhythm of a month at a glance.'])],
  ui: () => [
    element('div', { className: 'row' }, [element('span', { className: 'btn' }, ['Mac ', element('small', { textContent: 'Apple silicon' })]), element('span', { className: 'btn alt' }, ['Android ', element('small', { textContent: 'APK' })])]),
    element('nav', {}, [element('span', { textContent: 'Docs' }), element('span', { textContent: 'GitHub' }), element('span', { textContent: 'Releases' })]),
  ],
  mono: () => [element('p', {}, ['Press ', element('kbd', { textContent: '?' }), ' to see every shortcut.']), element('p', {}, ['Backticks turn text into ', element('code', { textContent: 'inline code' }), '.'])],
}

function fontOption(role, family, label, meta) {
  const candidate = withChoice(role.id, family)
  const pressed = family ? state.draft[role.id]?.family === family : !state.draft[role.id]
  const context = element('div', { className: `ctx ctx-${role.id}` }, CONTEXTS[role.id]())
  applyVars(context, contextVars(candidate))
  const button = element('button', { type: 'button', className: 'font-option' }, [
    context,
    element('span', { className: 'font-name' }, [element('b', { textContent: label }), element('span', { textContent: meta })]),
  ])
  button.setAttribute('aria-pressed', String(pressed))
  button.addEventListener('click', () => update(candidate))
  return button
}

function renderRoles() {
  $('roles').replaceChildren(...ROLES.map((role) => {
    const resolved = resolveRole(state.draft, role.id)
    const inherited = !state.draft[role.id] && role.follows
    const changed = JSON.stringify(state.draft[role.id]) !== JSON.stringify(state.saved[role.id])
    const label = element('span', { className: 'role-label', textContent: role.label })
    label.style.fontFamily = stack(resolved.font)
    label.style.fontWeight = role.weighted ? resolved.weight : ''
    const meta = element('span', { className: 'role-font' }, [
      ...(changed ? [element('span', { className: 'dot', title: 'Unsaved change' })] : []),
      role.weighted ? describe(resolved) : resolved.font.family,
      ...(inherited ? [element('span', { className: 'tag', textContent: `as ${roleById(role.follows).label}` })] : []),
    ])
    const button = element('button', { type: 'button', className: 'role' }, [label, meta])
    button.setAttribute('aria-current', String(role.id === state.role))
    button.addEventListener('click', () => selectRole(role.id))
    button.addEventListener('mouseenter', () => highlight(role.id))
    button.addEventListener('mouseleave', () => highlight(null))
    button.addEventListener('focus', () => highlight(role.id))
    button.addEventListener('blur', () => highlight(null))
    return element('li', {}, [button])
  }))
}

function renderWeights() {
  const role = roleById(state.role)
  if (!role.weighted) return $('weights').replaceChildren()
  const { font, weight } = resolveRole(state.draft, role.id)
  const available = new Set(weightOptions(font))
  $('weights').replaceChildren(...[100, 200, 300, 400, 500, 600, 700, 800, 900].map((option) => {
    const button = element('button', { type: 'button', textContent: option, disabled: !available.has(option) })
    button.style.fontFamily = stack(font)
    button.style.fontWeight = option
    button.setAttribute('aria-pressed', String(option === weight))
    button.addEventListener('click', () => update({ ...state.draft, [role.id]: { family: font.family, weight: option } }))
    return button
  }))
}

function renderFonts() {
  const role = roleById(state.role)
  const query = state.query.trim().toLowerCase()
  const fonts = FONTS.filter((font) => (state.category === 'all' || font.category === state.category) && font.family.toLowerCase().includes(query))
  const fallback = role.follows ? `Same as ${roleById(role.follows).label}` : 'Site default'
  const fallbackFont = resolveRole(withChoice(role.id, null), role.id)
  const options = [
    ...(query || state.category !== 'all' ? [] : [fontOption(role, null, fallback, describe(fallbackFont))]),
    ...fonts.map((font) => fontOption(role, font.family, font.family, font.category)),
  ]
  $('fonts').replaceChildren(...(options.length ? options : [element('p', { className: 'empty', textContent: 'No fonts match.' })]))
}

function renderPicker() {
  const role = roleById(state.role)
  $('picker-title').textContent = role.label
  $('picker-hint').textContent = role.hint
  renderWeights()
  renderFonts()
}

function renderCategories() {
  $('categories').replaceChildren(...['all', ...CATEGORIES].map((category) => {
    const button = element('button', { type: 'button', textContent: category })
    button.setAttribute('aria-pressed', String(category === state.category))
    button.addEventListener('click', () => {
      state.category = category
      renderCategories()
      renderFonts()
    })
    return button
  }))
}

function renderActions() {
  const changed = dirty()
  $('save').disabled = !changed
  $('revert').disabled = !changed
  $('reset').disabled = Object.keys(state.draft).length === 0
  if (changed) setStatus('Unsaved changes')
}

function update(draft) {
  state.draft = sanitizeSettings(draft)
  renderRoles()
  renderPicker()
  renderActions()
  applyPreview()
}

// The preview iframe is same-origin, so the draft replaces the saved overrides
// the Worker injected into it.
function applyPreview() {
  const doc = frame.contentDocument
  if (!doc?.head) return
  const hero = doc.querySelector('.hero h1')?.textContent.trim()
  if (hero && hero !== copy.hero) {
    copy.hero = hero
    copy.lede = doc.querySelector('.hero .lede')?.textContent.trim().split(/(?<=\.) /)[0] ?? ''
    renderFonts()
  }
  doc.querySelectorAll('#font-overrides, #font-overrides-css').forEach((node) => node.remove())
  let link = doc.getElementById('draft-fonts')
  let style = doc.getElementById('draft-overrides')
  if (!link) doc.head.append(link = doc.createElement('link'), style = doc.createElement('style'))
  Object.assign(link, { id: 'draft-fonts', rel: 'stylesheet' })
  style.id = 'draft-overrides'
  const families = fontFamilies(state.draft)
  if (families.length) link.href = fontCssUrl(families)
  else link.removeAttribute('href')
  const selectors = state.highlight && roleById(state.highlight).selectors
  style.textContent = overrideCss(state.draft) +
    (selectors ? `${selectors} { outline: 2px dashed #539f9c; outline-offset: 3px; border-radius: 2px; }` : '')
}

function highlight(roleId) {
  state.highlight = roleId
  applyPreview()
}

function selectRole(roleId) {
  state.role = roleId
  renderRoles()
  renderPicker()
  $('fonts').closest('.panel').scrollTo({ top: 0 })
  const doc = frame.contentDocument
  const selectors = roleById(roleId).selectors
  const target = doc?.querySelector(selectors)
  if (target) {
    const rect = target.getBoundingClientRect()
    if (rect.bottom < 0 || rect.top > frame.clientHeight) target.scrollIntoView({ block: 'center', behavior: 'smooth' })
  } else if (doc) {
    showPage(state.page === '/' ? '/docs/' : '/')
  }
}

function showPage(page) {
  state.page = page
  for (const button of document.querySelectorAll('[data-page]')) button.setAttribute('aria-pressed', String(button.dataset.page === page))
  frame.src = page
}

async function save() {
  $('save').disabled = true
  setStatus('Saving…')
  try {
    const response = await fetch('/admin/api/fonts', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ settings: state.draft }),
    })
    if (!response.ok) throw new Error(response.status === 401 ? 'Signed out. Reload to sign in again.' : `Save failed (${response.status})`)
    state.saved = (await response.json()).settings
    update(state.saved)
    setStatus('Saved. Live on the site within a minute.')
  } catch (error) {
    setStatus(error.message, true)
    renderActions()
  }
}

async function start() {
  loadCatalogFonts()
  renderCategories()
  frame.addEventListener('load', applyPreview)
  for (const button of document.querySelectorAll('[data-page]')) button.addEventListener('click', () => showPage(button.dataset.page))
  for (const button of document.querySelectorAll('[data-width]')) {
    button.addEventListener('click', () => {
      for (const other of document.querySelectorAll('[data-width]')) other.setAttribute('aria-pressed', String(other === button))
      $('frame-wrap').classList.toggle('phone', button.dataset.width === 'phone')
    })
  }
  $('search').addEventListener('input', (event) => {
    state.query = event.target.value
    renderFonts()
  })
  $('save').addEventListener('click', save)
  $('revert').addEventListener('click', () => update(state.saved))
  $('reset').addEventListener('click', () => update({}))
  addEventListener('beforeunload', (event) => { if (dirty()) event.preventDefault() })
  addEventListener('keydown', (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === 's') {
      event.preventDefault()
      if (dirty()) save()
    }
  })

  update({})
  try {
    const response = await fetch('/admin/api/fonts')
    if (!response.ok) throw new Error(`Could not load settings (${response.status})`)
    state.saved = (await response.json()).settings
    update(state.saved)
    setStatus('')
  } catch (error) {
    setStatus(error.message, true)
  }
}

start()
