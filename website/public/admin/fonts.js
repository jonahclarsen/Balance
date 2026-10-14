// Font roles and the catalog /admin picks from. The Worker imports this too, to
// validate saved settings and build the override CSS it injects into pages.

const SANS = "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
const SERIF = "ui-serif, Georgia, 'Times New Roman', serif"
const MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace'
const ROUNDED = "ui-rounded, 'SF Pro Rounded', " + SANS
const FALLBACKS = { sans: SANS, serif: SERIF, display: SANS, mono: MONO }

// `range` is a variable font's weight axis; `weights` lists a static font's cuts.
export const FONTS = [
  { family: 'System sans', category: 'system', stack: SANS, range: [100, 900] },
  { family: 'System serif', category: 'system', stack: SERIF, range: [100, 900] },
  { family: 'System rounded', category: 'system', stack: ROUNDED, range: [100, 900] },
  { family: 'System mono', category: 'system', stack: MONO, range: [100, 900] },

  { family: 'Sora', category: 'sans', range: [100, 800] },
  { family: 'Inter', category: 'sans', range: [100, 900] },
  { family: 'Geist', category: 'sans', range: [100, 900] },
  { family: 'Manrope', category: 'sans', range: [200, 800] },
  { family: 'DM Sans', category: 'sans', range: [100, 1000] },
  { family: 'Plus Jakarta Sans', category: 'sans', range: [200, 800] },
  { family: 'Outfit', category: 'sans', range: [100, 900] },
  { family: 'Figtree', category: 'sans', range: [300, 900] },
  { family: 'Onest', category: 'sans', range: [100, 900] },
  { family: 'Instrument Sans', category: 'sans', range: [400, 700] },
  { family: 'Hanken Grotesk', category: 'sans', range: [100, 900] },
  { family: 'Schibsted Grotesk', category: 'sans', range: [400, 900] },
  { family: 'Space Grotesk', category: 'sans', range: [300, 700] },
  { family: 'Albert Sans', category: 'sans', range: [100, 900] },
  { family: 'Public Sans', category: 'sans', range: [100, 900] },
  { family: 'Work Sans', category: 'sans', range: [100, 900] },
  { family: 'Rubik', category: 'sans', range: [300, 900] },
  { family: 'Nunito', category: 'sans', range: [200, 1000] },
  { family: 'Lexend', category: 'sans', range: [100, 900] },
  { family: 'Urbanist', category: 'sans', range: [100, 900] },
  { family: 'Archivo', category: 'sans', range: [100, 900] },
  { family: 'IBM Plex Sans', category: 'sans', range: [100, 700] },

  { family: 'Fraunces', category: 'serif', range: [100, 900] },
  { family: 'Newsreader', category: 'serif', range: [200, 800] },
  { family: 'Source Serif 4', category: 'serif', range: [200, 900] },
  { family: 'Literata', category: 'serif', range: [200, 900] },
  { family: 'Lora', category: 'serif', range: [400, 700] },
  { family: 'Crimson Pro', category: 'serif', range: [200, 900] },
  { family: 'EB Garamond', category: 'serif', range: [400, 800] },
  { family: 'Playfair Display', category: 'serif', range: [400, 900] },
  { family: 'Bodoni Moda', category: 'serif', range: [400, 900] },
  { family: 'Libre Baskerville', category: 'serif', weights: [400, 700] },
  { family: 'Instrument Serif', category: 'serif', weights: [400] },
  { family: 'DM Serif Display', category: 'serif', weights: [400] },
  { family: 'Young Serif', category: 'serif', weights: [400] },

  { family: 'Bricolage Grotesque', category: 'display', range: [200, 800] },
  { family: 'Syne', category: 'display', range: [400, 800] },
  { family: 'Unbounded', category: 'display', range: [200, 900] },
  { family: 'Big Shoulders Display', category: 'display', range: [100, 900] },
  { family: 'Darker Grotesque', category: 'display', range: [300, 900] },
  { family: 'Bebas Neue', category: 'display', weights: [400] },
  { family: 'Archivo Black', category: 'display', weights: [400] },
  { family: 'Abril Fatface', category: 'display', weights: [400] },
  { family: 'Righteous', category: 'display', weights: [400] },
  { family: 'Shrikhand', category: 'display', weights: [400] },
  { family: 'Dela Gothic One', category: 'display', weights: [400] },

  { family: 'JetBrains Mono', category: 'mono', range: [100, 800] },
  { family: 'Geist Mono', category: 'mono', range: [100, 900] },
  { family: 'IBM Plex Mono', category: 'mono', weights: [100, 200, 300, 400, 500, 600, 700] },
  { family: 'Fira Code', category: 'mono', range: [300, 700] },
  { family: 'Source Code Pro', category: 'mono', range: [200, 900] },
  { family: 'Roboto Mono', category: 'mono', range: [100, 700] },
  { family: 'DM Mono', category: 'mono', weights: [300, 400, 500] },
  { family: 'Space Mono', category: 'mono', weights: [400, 700] },
]

export const CATEGORIES = ['sans', 'serif', 'display', 'mono', 'system']

// Each role maps to CSS variables in site.css. Roles without `default` follow
// another role until overridden. `alsoWeights` are cuts the role's elements use
// beyond its chosen weight (bold text, buttons), so they load too.
export const ROLES = [
  { id: 'heading', label: 'Headings', hint: 'Section titles, feature tiles, docs headings', weighted: true, default: { family: 'Sora', weight: 700 }, selectors: 'h1, h2, h3, .tile figcaption strong' },
  { id: 'hero', label: 'Hero title', hint: 'The large title at the top of the homepage', weighted: true, follows: 'heading', selectors: '.hero h1' },
  { id: 'wordmark', label: 'Wordmark', hint: 'The name beside the logo', weighted: true, follows: 'heading', selectors: '.wordmark' },
  { id: 'body', label: 'Body', hint: 'Paragraphs, captions, tables, footer', weighted: true, default: { family: 'System sans', weight: 400 }, alsoWeights: [600, 700], selectors: 'p, li, figcaption, td, footer span' },
  { id: 'ui', label: 'Nav & buttons', hint: 'Nav links, download buttons, docs contents', follows: 'body', alsoWeights: [500, 600, 700], selectors: '.top nav a, .button, .more, .docs-nav a, footer nav a' },
  { id: 'mono', label: 'Code & keys', hint: 'Keyboard shortcuts and code in the docs', default: { family: 'System mono', weight: 400 }, alsoWeights: [600], selectors: 'kbd, code' },
]

export function findFont(family) {
  return FONTS.find((font) => font.family === family)
}

export function isGoogle(font) {
  return font.category !== 'system'
}

export function stack(font) {
  if (font.stack) return font.stack
  return `'${font.family}', ${FALLBACKS[font.category]}`
}

export function weightOptions(font) {
  if (font.weights) return font.weights
  const options = []
  for (let weight = Math.ceil(font.range[0] / 100) * 100; weight <= Math.min(font.range[1], 900); weight += 100) options.push(weight)
  return options
}

export function nearestWeight(font, weight) {
  return weightOptions(font).reduce((best, option) => Math.abs(option - weight) < Math.abs(best - weight) ? option : best)
}

// The font and weight a role currently renders with, following inherited roles.
export function resolveRole(settings, roleId) {
  const role = ROLES.find((candidate) => candidate.id === roleId)
  if (!settings[roleId] && role.follows) return resolveRole(settings, role.follows)
  const choice = settings[roleId] ?? role.default
  const font = findFont(choice.family)
  return { font, weight: nearestWeight(font, choice.weight ?? 400) }
}

// Keeps only known roles, fonts and weights so saved settings are always safe
// to splice into CSS.
export function sanitizeSettings(input) {
  const settings = {}
  if (!input || typeof input !== 'object') return settings
  for (const role of ROLES) {
    const choice = input[role.id]
    const font = choice && findFont(choice.family)
    if (!font) continue
    settings[role.id] = { family: font.family, weight: nearestWeight(font, Number(choice.weight) || 400) }
  }
  return settings
}

export function overrideCss(settings) {
  const declarations = []
  for (const role of ROLES) {
    const choice = settings[role.id]
    if (!choice) continue
    const font = findFont(choice.family)
    declarations.push(`--font-${role.id}: ${stack(font)};`)
    if (role.weighted) declarations.push(`--weight-${role.id}: ${choice.weight};`)
  }
  return declarations.length ? `:root { ${declarations.join(' ')} }` : ''
}

function isDefault(settings, roleId) {
  const role = ROLES.find((candidate) => candidate.id === roleId)
  return !settings[roleId] && (!role.follows || isDefault(settings, role.follows))
}

// css2 `family` values for every overridden web font, with each cut the page
// needs. Roles left at their defaults use the fonts site.css already loads.
export function fontFamilies(settings) {
  const needed = new Map()
  for (const role of ROLES) {
    if (isDefault(settings, role.id)) continue
    const { font, weight } = resolveRole(settings, role.id)
    if (!isGoogle(font)) continue
    const weights = needed.get(font.family) ?? new Set()
    for (const cut of [weight, ...(role.alsoWeights ?? [])]) weights.add(nearestWeight(font, cut))
    needed.set(font.family, weights)
  }
  return [...needed].map(([family, weights]) => familySpec(family, [...weights]))
}

export function familySpec(family, weights) {
  return `${family}:wght@${[...new Set(weights)].sort((a, b) => a - b).join(';')}`
}

// All of a font's cuts, for the admin previews.
export function fullFamilySpec(font) {
  return font.range ? `${font.family}:wght@${font.range[0]}..${font.range[1]}` : familySpec(font.family, font.weights)
}

export function fontCssUrl(families) {
  const query = families.map((family) => `family=${encodeURIComponent(family).replace(/%20/g, '+')}`).join('&')
  return `/fonts/css?${query}`
}
