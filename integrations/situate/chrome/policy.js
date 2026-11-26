// No page content, messages, tokens, or browsing history enter native messaging.
export function effectiveStatus(status, now = Date.now()) {
  if (!status || status.version !== 1) return null
  if (status.enabled && status.refreshAt <= now) return { ...status, aiBlocked: true, stale: true, modes: status.modes.map(m => ({ ...m, active: true, targets: m.allTargets ?? m.targets })) }
  return status
}
// Work tools on a blocked site's subdomains stay open unless a target names them.
const WORK_SUBDOMAINS = { 'facebook.com': ['business', 'adsmanager', 'developers'] }
const clean = host => host.toLowerCase().replace(/\.$/, '')
const workHost = (host, domain) => (WORK_SUBDOMAINS[domain] ?? []).some(s => host === `${s}.${domain}` || host.endsWith(`.${s}.${domain}`))
export function domainMatches(host, domain, top = '') {
  host = clean(host); domain = clean(domain); top = clean(top)
  if (host !== domain && !host.endsWith(`.${domain}`)) return false
  // Frames a work tool embeds from the blocked site belong to that tool.
  return !workHost(host, domain) && !(top && workHost(top, domain))
}
export function blockedBy(status, rawURL, parent = '', topURL = '') {
  let url, top = ''
  try { url = new URL(rawURL) } catch { return [] }
  try { top = topURL ? new URL(topURL).hostname : '' } catch {}
  if (!['http:', 'https:'].includes(url.protocol)) return []
  // Discord paths are /channels/<guild>/<channel>[/threads/<thread>].
  const segments = url.hostname === 'discord.com' || url.hostname.endsWith('.discord.com') ? url.pathname.split('/').filter(Boolean) : []
  const id = value => /^\d+$/.test(value ?? '') ? value : ''
  const channel = segments[0] === 'channels' ? id(segments[2]) : ''
  // A thread opened on its own page has no parent in its URL; the page reports it from the sidebar.
  const owner = channel && segments[3] === 'threads' && id(segments[4]) ? channel : channel && /^\d{15,22}$/.test(parent) && parent !== channel ? parent : ''
  const thread = channel && segments[3] === 'threads' ? id(segments[4]) : ''
  const current=effectiveStatus(status)
  return (current?.modes ?? []).flatMap(mode => [
    ...(mode.id === 'touch-grass' && mode.active && [channel, thread].some(open => open && (current.frankThreads ?? []).includes(open)) ? [{ mode:mode.id, name:mode.name, target:'' }] : []),
    // A chosen channel blocks only the threads opened inside it.
    ...(mode.targets ?? []).filter(t => t.kind === 'domain' ? domainMatches(url.hostname,t.value,top) : t.kind === 'discord' && owner && t.value === owner)
      .map(target => ({ mode:mode.id, name:mode.name, target: target.category === 'entertainment' ? target.id : '' })),
  ])
}
