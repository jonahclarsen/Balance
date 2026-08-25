export const BALANCE_DEEP_LINK_EVENT = 'balance-deep-link'
export const MAX_SIRI_TASK_LENGTH = 2_000

export type AddToBalanceDeepLink = {
  kind: 'add'
  requestId: string
  text: string
}

export function parseBalanceDeepLink(raw: string): AddToBalanceDeepLink | null {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }

  if (url.protocol !== 'balance:' || url.hostname !== 'add') return null

  const text = url.searchParams.get('text') ?? ''
  const requestId = url.searchParams.get('request') ?? ''
  if (!text.trim() || Array.from(text).length > MAX_SIRI_TASK_LENGTH) return null
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(requestId)) return null

  return { kind: 'add', requestId, text }
}
