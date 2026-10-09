import { VANCOUVER_SUNSETS } from './vancouverSunsets'

const vancouverClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Vancouver', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
})
// `{sunset+4h <10pm}` or `[10am]`: an anchor (sunset or a clock time), an
// optional offset, then up to two bounds. `<10pm` means "no later than 10pm"
// and `>5pm` "no earlier than 5pm". Anything else in brackets stays literal.
const tokenPattern = /\[([^[\]{}\n]{1,60})\]|\{([^[\]{}\n]{1,60})\}/g
const clock = String.raw`\d{1,2}(?::\d{2})?\s*[ap]m|\d{1,2}:\d{2}`
const bodyPattern = new RegExp(String.raw`^\s*(sunset|${clock})\s*([+-]\s*(?:\d+h(?:\d+m)?|\d+m))?((?:\s*[<>≤≥]\s*(?:${clock})){0,2})\s*$`, 'i')
const boundPattern = new RegExp(String.raw`([<>≤≥])\s*(${clock})`, 'gi')

function dateMidnight(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const midnight = Date.parse(`${date}T00:00:00Z`)
  return Number.isFinite(midnight) && new Date(midnight).toISOString().slice(0, 10) === date ? midnight : null
}

/** Bundled, minute-resolution apparent sunset; unsupported/invalid dates stay literal. */
export function vancouverSunsetTimestamp(date: string): number | null {
  const midnight = dateMidnight(date)
  if (midnight === null) return null
  const year = Number(date.slice(0, 4))
  const day = (midnight - Date.UTC(year, 0, 1)) / 86400000
  const utcMinutes = VANCOUVER_SUNSETS[year]?.[day]
  if (utcMinutes === undefined) return null
  return midnight + utcMinutes * 60000
}

function clockMinutes(timestamp: number): number {
  const parts = vancouverClock.formatToParts(new Date(timestamp))
  return Number(parts.find(part => part.type === 'hour')!.value) * 60
    + Number(parts.find(part => part.type === 'minute')!.value)
}

export function vancouverSunsetMinutes(date: string): number | null {
  const timestamp = vancouverSunsetTimestamp(date)
  return timestamp === null ? null : clockMinutes(timestamp)
}

function parseClock(value: string): number | null {
  const match = value.replace(/\s/g, '').toLowerCase().match(/^(\d{1,2})(?::(\d{2}))?([ap]m)?$/)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2] ?? 0)
  if (minute > 59) return null
  if (!match[3]) return hour < 24 ? hour * 60 + minute : null
  if (hour < 1 || hour > 12) return null
  return (hour % 12 + (match[3] === 'pm' ? 12 : 0)) * 60 + minute
}

// Times before Balance's 5 a.m. day boundary belong to the following night.
function vancouverClockTimestamp(date: string, minutes: number): number | null {
  const midnight = dateMidnight(date)
  if (midnight === null) return null
  let timestamp = midnight + (minutes + (minutes < 5 * 60 ? 1440 : 0) + 8 * 60) * 60000
  for (let attempt = 0; attempt < 2; attempt++) {
    timestamp -= (((clockMinutes(timestamp) - minutes) % 1440 + 2160) % 1440 - 720) * 60000
  }
  return timestamp
}

function tokenTimestamp(body: string, date: string): number | null {
  const match = body.match(bodyPattern)
  if (!match) return null
  const anchorClock = parseClock(match[1])
  const anchor = match[1].toLowerCase() === 'sunset'
    ? vancouverSunsetTimestamp(date)
    : anchorClock === null ? null : vancouverClockTimestamp(date, anchorClock)
  if (anchor === null) return null
  const offset = (match[2] ?? '').replace(/\s/g, '').toLowerCase()
  const delta = Number(offset.match(/(\d+)h/)?.[1] ?? 0) * 60 + Number(offset.match(/(\d+)m/)?.[1] ?? 0)
  let timestamp = anchor + (offset.startsWith('-') ? -delta : delta) * 60000
  for (const [, direction, value] of match[3].matchAll(boundPattern)) {
    const minutes = parseClock(value)
    const bound = minutes === null ? null : vancouverClockTimestamp(date, minutes)
    if (bound === null) return null
    timestamp = direction === '<' || direction === '≤' ? Math.min(timestamp, bound) : Math.max(timestamp, bound)
  }
  return Number.isSafeInteger(timestamp) && Math.abs(timestamp) <= 8640000000000000 ? timestamp : null
}

function replacement(token: string, body: string, date: string): string {
  const timestamp = tokenTimestamp(body, date)
  if (timestamp === null) return token
  const minutes = clockMinutes(timestamp)
  const hour = Math.floor(minutes / 60)
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

export function templateTimeNotificationTimes(text: string, date: string): number[] {
  const times = new Set<number>()
  for (const match of text.matchAll(tokenPattern)) {
    const timestamp = tokenTimestamp(match[1] ?? match[2], date)
    if (timestamp !== null) times.add(timestamp)
  }
  return [...times]
}

function expand(value: string, date: string): string {
  return value.replace(tokenPattern, (token, square, brace) => replacement(token, square ?? brace, date))
}

const NAMED_ENTITIES: Record<string, string> = { '&nbsp;': ' ', '&lt;': '<', '&gt;': '>', '&amp;': '&' }

// Track visible character positions back to their HTML source. This lets a
// placeholder span bold/italic runs without touching attributes or dropping tags.
function expandHTML(html: string, date: string): string {
  let visible = ''
  const positions: { start: number; end: number }[] = []
  const parts = /<(?:[^>"']|"[^"]*"|'[^']*')*>|&(?:#x[\da-f]+|#\d+|[a-z]+);|[^<&]+|[<&]/gi
  for (const part of html.matchAll(parts)) {
    const source = part[0]
    const start = part.index!
    if (source.startsWith('<') && source.length > 1) {
      if (/^<\/?(?:p|div|br|li|img)\b/i.test(source)) {
        visible += '￼'
        positions.push({ start, end: start })
      }
      continue
    }
    if (source.startsWith('&') && source.endsWith(';')) {
      const numeric = source.match(/^&#(x[\da-f]+|\d+);$/i)?.[1]
      const code = numeric ? numeric.toLowerCase().startsWith('x') ? parseInt(numeric.slice(1), 16) : Number(numeric) : NaN
      const decoded = NAMED_ENTITIES[source.toLowerCase()] ?? (code >= 0 && code <= 127 ? String.fromCharCode(code) : '￼')
      visible += decoded
      positions.push({ start, end: start + source.length })
    } else {
      visible += source
      for (let i = 0; i < source.length; i++) positions.push({ start: start + i, end: start + i + 1 })
    }
  }
  const edits: { start: number; end: number; value: string }[] = []
  for (const match of visible.matchAll(tokenPattern)) {
    const value = replacement(match[0], match[1] ?? match[2], date)
    if (value === match[0]) continue
    for (let i = 0; i < match[0].length; i++) {
      edits.push({ ...positions[match.index! + i], value: i === 0 ? value : '' })
    }
  }
  let result = ''
  let cursor = 0
  for (const edit of edits) {
    result += html.slice(cursor, edit.start) + edit.value
    cursor = edit.end
  }
  return result + html.slice(cursor)
}

export function expandTemplateTimes(text: string, html: string, date: string): { text: string; html: string } {
  if (!/[[{]|&#/.test(text + html)) return { text, html }
  return { text: expand(text, date), html: expandHTML(html, date) }
}
