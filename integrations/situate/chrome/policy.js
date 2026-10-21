// No page content, messages, tokens, or browsing history enter native messaging.
export function effectiveStatus(status, now = Date.now()) {
  if (!status || status.version !== 1) return null
  if (status.enabled && status.refreshAt <= now) return { ...status, aiBlocked: true, stale: true, modes: status.modes.map(m => ({ ...m, active: true, targets: m.allTargets ?? m.targets })) }
  return status
}
export function domainMatches(host, domain) {
  host = host.toLowerCase().replace(/\.$/, ''); domain = domain.toLowerCase().replace(/\.$/, '')
  return host === domain || host.endsWith(`.${domain}`)
}
export function blockedBy(status, rawURL) {
  let url
  try { url = new URL(rawURL) } catch { return [] }
  if (!['http:', 'https:'].includes(url.protocol)) return []
  // Discord paths are /channels/<guild>/<channel>[/threads/<thread>].
  const segments = url.hostname === 'discord.com' || url.hostname.endsWith('.discord.com') ? url.pathname.split('/').filter(Boolean) : []
  const id = value => /^\d+$/.test(value ?? '') ? value : ''
  const channel = segments[0] === 'channels' ? id(segments[2]) : ''
  const thread = channel && segments[3] === 'threads' ? id(segments[4]) : ''
  const current=effectiveStatus(status)
  return (current?.modes ?? []).flatMap(mode => [
    ...(mode.id === 'touch-grass' && mode.active && [channel, thread].some(open => open && (current.frankThreads ?? []).includes(open)) ? [{ mode:mode.id, name:mode.name, target:'' }] : []),
    // A chosen channel blocks only the threads opened inside it.
    ...(mode.targets ?? []).filter(t => t.kind === 'domain' ? domainMatches(url.hostname,t.value) : t.kind === 'discord' && thread && t.value === channel)
      .map(target => ({ mode:mode.id, name:mode.name, target: target.category === 'entertainment' ? target.id : '' })),
  ])
}
