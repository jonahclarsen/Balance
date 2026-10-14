// balance.jonah.art: static site plus download links that always point at the
// newest GitHub release carrying each platform's build, and /admin for fonts.

import { findFont, fontCssUrl, fontFamilies, overrideCss, sanitizeFavorites, sanitizeSettings } from './public/admin/fonts.js'

const REPO = 'jonahclarsen/Balance'
const RELEASES = `https://github.com/${REPO}/releases`
const CACHE_SECONDS = 600

const PLATFORMS = {
  mac: /^Balance-macos-.*\.zip$/,
  android: /\.apk$/,
  linux: /\.AppImage$/,
}

async function latestBuilds() {
  const builds = {}
  for (let page = 1; page <= 5 && Object.keys(builds).length < Object.keys(PLATFORMS).length; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${REPO}/releases?per_page=100&page=${page}`, {
      headers: { 'user-agent': 'balance.jonah.art', accept: 'application/vnd.github+json' },
      cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
    })
    if (!response.ok) throw new Error(`GitHub responded ${response.status}`)
    const releases = await response.json()
    if (releases.length === 0) break
    for (const release of releases) {
      if (release.draft || release.prerelease) continue
      for (const [platform, pattern] of Object.entries(PLATFORMS)) {
        if (builds[platform]) continue
        const asset = release.assets.find((candidate) => pattern.test(candidate.name))
        if (asset) builds[platform] = { version: release.tag_name, url: asset.browser_download_url, notes: release.html_url }
      }
    }
  }
  return builds
}

async function cachedBuilds(ctx) {
  const cache = caches.default
  const key = new Request('https://balance.jonah.art/__builds')
  const hit = await cache.match(key)
  if (hit) return hit.json()
  const builds = await latestBuilds()
  ctx.waitUntil(cache.put(key, new Response(JSON.stringify(builds), {
    headers: { 'cache-control': `max-age=${CACHE_SECONDS}` },
  })))
  return builds
}

const FONT_SETTINGS_KEY = 'fonts'
const FAVORITES_KEY = 'font-favorites'
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36'

function base64url(text) {
  return Uint8Array.from(atob(text.replace(/-/g, '+').replace(/_/g, '/')), (char) => char.charCodeAt(0))
}

// /admin sits behind the same Cloudflare Access application as jonah.art/admin.
// Access enforces the login at the edge; this re-checks its signed token.
export async function accessAuthorized(request, env, resolveKey = accessKey) {
  const issuer = env.ACCESS_ISSUER
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/.test(issuer ?? '') || !env.ACCESS_AUD || !env.ADMIN_EMAIL) return false
  const token = request.headers.get('cf-access-jwt-assertion') ||
    (request.headers.get('cookie') ?? '').match(/(?:^|;\s*)CF_Authorization=([^;]+)/)?.[1]
  const parts = token?.split('.')
  if (parts?.length !== 3) return false
  try {
    const decoder = new TextDecoder()
    const header = JSON.parse(decoder.decode(base64url(parts[0])))
    const claims = JSON.parse(decoder.decode(base64url(parts[1])))
    if (header.alg !== 'RS256') return false
    const key = await resolveKey(issuer, header.kid)
    const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`)
    if (!key || !await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, base64url(parts[2]), signed)) return false
    const now = Date.now() / 1000
    const audiences = [claims.aud].flat()
    return claims.iss === issuer && audiences.includes(env.ACCESS_AUD) && claims.exp > now &&
      !(claims.nbf > now) && claims.type === 'app' && claims.email === env.ADMIN_EMAIL
  } catch {
    return false
  }
}

async function accessKey(issuer, kid) {
  const response = await fetch(`${issuer}/cdn-cgi/access/certs`, { cf: { cacheTtl: 3600, cacheEverything: true } })
  const jwk = (await response.json()).keys?.find((key) => key.kid === kid)
  return jwk && crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify'])
}

async function fontSettings(env) {
  return sanitizeSettings(await env.SETTINGS.get(FONT_SETTINGS_KEY, { type: 'json', cacheTtl: 30 }))
}

// The admin reads KV uncached so it always sees its own latest writes.
async function fontAdminApi(request, env, path) {
  const json = (body) => Response.json(body, { headers: { 'cache-control': 'no-store' } })
  if (request.method === 'GET' && path === '/admin/api/fonts') {
    const [settings, favorites] = await Promise.all([env.SETTINGS.get(FONT_SETTINGS_KEY, 'json'), env.SETTINGS.get(FAVORITES_KEY, 'json')])
    return json({ settings: sanitizeSettings(settings), favorites: sanitizeFavorites(favorites) })
  }
  if (request.method !== 'PUT') return new Response(null, { status: 405 })
  if (request.headers.get('origin') !== new URL(request.url).origin) return new Response('Invalid origin', { status: 403 })
  const body = await request.json().catch(() => null)
  if (path === '/admin/api/favorites') {
    const favorites = sanitizeFavorites(body?.favorites)
    await env.SETTINGS.put(FAVORITES_KEY, JSON.stringify(favorites))
    return json({ favorites })
  }
  const settings = sanitizeSettings(body?.settings)
  await env.SETTINGS.put(FONT_SETTINGS_KEY, JSON.stringify(settings))
  return json({ settings })
}

// Google Fonts, served first-party so visitors never contact Google.
async function fontCss(url, ctx) {
  const families = url.searchParams.getAll('family')
  const valid = families.length > 0 && families.length <= 8 && families.every((family) => {
    const match = family.match(/^([A-Za-z0-9 ]+):wght@(\d{3,4}(?:\.\.\d{3,4}|(?:;\d{3,4})*))$/)
    const font = match && findFont(match[1])
    return font && font.category !== 'system'
  })
  if (!valid) return new Response('Unknown font', { status: 400 })
  const cache = caches.default
  const key = new Request(url.toString())
  const hit = await cache.match(key)
  if (hit) return hit
  const google = new URL('https://fonts.googleapis.com/css2')
  for (const family of families) google.searchParams.append('family', family)
  google.searchParams.set('display', 'swap')
  const upstream = await fetch(google, { headers: { 'user-agent': BROWSER_UA } })
  if (!upstream.ok) return new Response('Font unavailable', { status: 502 })
  const css = (await upstream.text()).replaceAll('https://fonts.gstatic.com/', '/fonts/file/')
  const response = new Response(css, { headers: { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, max-age=86400' } })
  ctx.waitUntil(cache.put(key, response.clone()))
  return response
}

async function fontFile(url) {
  const path = url.pathname.slice('/fonts/file/'.length)
  if (!/^[\w./-]+\.woff2$/.test(path) || path.includes('..')) return new Response(null, { status: 404 })
  const upstream = await fetch(`https://fonts.gstatic.com/${path}`, { cf: { cacheTtl: 31536000, cacheEverything: true } })
  if (!upstream.ok) return new Response(null, { status: upstream.status })
  return new Response(upstream.body, {
    headers: { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' },
  })
}

// Pages carry the saved font overrides, so they skip asset revalidation:
// an unchanged file can still need new fonts.
async function servePage(request, env) {
  const headers = new Headers(request.headers)
  headers.delete('if-none-match')
  headers.delete('if-modified-since')
  const response = await env.ASSETS.fetch(new Request(request, { headers }))
  if (!response.headers.get('content-type')?.startsWith('text/html')) return response
  const settings = await fontSettings(env)
  const css = overrideCss(settings)
  const page = new Response(response.body, response)
  page.headers.delete('etag')
  page.headers.delete('last-modified')
  page.headers.set('cache-control', 'no-cache')
  if (!css) return page
  const families = fontFamilies(settings)
  const link = families.length ? `<link id="font-overrides-css" rel="stylesheet" href="${fontCssUrl(families)}">` : ''
  return new HTMLRewriter().on('head', {
    element(head) { head.append(`${link}<style id="font-overrides">${css}</style>`, { html: true }) },
  }).transform(page)
}

// `authorize` is swappable so the admin can be exercised locally without Access.
export function createWorker(authorize = accessAuthorized) {
  return { fetch: (request, env, ctx) => handle(request, env, ctx, authorize) }
}

export default createWorker()

async function handle(request, env, ctx, authorize) {
  const url = new URL(request.url)
  if (url.pathname === '/admin' || url.pathname.startsWith('/admin/')) {
    if (!await authorize(request, env)) return new Response('Sign in through Cloudflare Access.', { status: 401 })
    if (url.pathname === '/admin/api/fonts' || url.pathname === '/admin/api/favorites') return fontAdminApi(request, env, url.pathname)
    return env.ASSETS.fetch(request)
  }
  if (url.pathname === '/fonts/css') return fontCss(url, ctx)
  if (url.pathname.startsWith('/fonts/file/')) return fontFile(url)
  const download = url.pathname.match(/^\/download\/(mac|android|linux)\/?$/)
  if (download) {
    let location = `${RELEASES}/latest`
    try {
      location = (await cachedBuilds(ctx))[download[1]]?.url ?? location
    } catch {
      // GitHub is unreachable or rate limited; the releases page still works.
    }
    return new Response(null, { status: 302, headers: { location, 'cache-control': 'no-store' } })
  }
  if (url.pathname === '/api/builds') {
    try {
      return Response.json(await cachedBuilds(ctx), { headers: { 'cache-control': `max-age=${CACHE_SECONDS}` } })
    } catch {
      return Response.json({}, { status: 503 })
    }
  }
  if (/^\/(assets|images)\//.test(url.pathname)) return env.ASSETS.fetch(request)
  return servePage(request, env)
}
