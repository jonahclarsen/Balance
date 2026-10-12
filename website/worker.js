// balance.jonah.art: static site plus download links that always point at the
// newest GitHub release carrying each platform's build.

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

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url)
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
    return env.ASSETS.fetch(request)
  },
}
