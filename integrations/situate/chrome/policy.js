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
  const channels = url.hostname === 'discord.com' || url.hostname.endsWith('.discord.com') ? url.pathname.split('/').slice(2).filter(s => /^\d+$/.test(s)) : []
  const current=effectiveStatus(status)
  return (current?.modes ?? []).flatMap(mode => [
    ...(mode.id === 'touch-grass' && mode.active && (current.frankThreads ?? []).some(id => channels.includes(id)) ? [{ mode:mode.id,name:mode.name,target:'' }] : []),
    ...(mode.targets ?? []).filter(t =>
    t.kind === 'domain' ? domainMatches(url.hostname,t.value) : t.kind === 'discord' && channels.includes(t.value)
  ).map(target => ({ mode: mode.id, name: mode.name, target: target.category === 'entertainment' ? target.id : '' }))])
}
