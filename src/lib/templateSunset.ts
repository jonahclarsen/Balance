import { VANCOUVER_SUNSETS } from './vancouverSunsets'

const vancouverClock = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Vancouver', hour: 'numeric', minute: '2-digit', hourCycle: 'h23',
})
const tokenPattern = /\[sunset\s*((?:[+-]\s*(?:\d+h(?:\d+m)?|\d+m))?)\s*\]|\{sunset\s*((?:[+-]\s*(?:\d+h(?:\d+m)?|\d+m))?)\s*\}/gi

/** Bundled, minute-resolution apparent sunset; unsupported/invalid dates stay literal. */
export function vancouverSunsetTimestamp(date: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const midnight = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== date) return null
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

function offsetTimestamp(offset: string, sunset: number): number | null {
  offset = offset.replace(/\s/g, '').toLowerCase()
  const hours = Number(offset.match(/(\d+)h/)?.[1] ?? 0)
  const minutes = Number(offset.match(/(\d+)m/)?.[1] ?? 0)
  const delta = hours * 60 + minutes
  const timestamp = sunset + (offset.startsWith('-') ? -delta : delta) * 60000
  return Number.isSafeInteger(timestamp) && Math.abs(timestamp) <= 8640000000000000 ? timestamp : null
}

function replacement(token: string, squareOffset: string | undefined, braceOffset: string | undefined, sunset: number): string {
  const timestamp = offsetTimestamp(squareOffset ?? braceOffset ?? '', sunset)
  if (timestamp === null) return token
  const minutes = clockMinutes(timestamp)
  const hour = Math.floor(minutes / 60)
  return `${hour % 12 || 12}:${String(minutes % 60).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}

export function templateSunsetNotificationTimes(text: string, date: string): number[] {
  const sunset = vancouverSunsetTimestamp(date)
  if (sunset === null) return []
  const times = new Set<number>()
  for (const match of text.matchAll(tokenPattern)) {
    const timestamp = offsetTimestamp(match[1] ?? match[2] ?? '', sunset)
    if (timestamp !== null) times.add(timestamp)
  }
  return [...times]
}

function expand(value: string, sunset: number): string {
  return value.replace(tokenPattern, (token, squareOffset, braceOffset) => replacement(token, squareOffset, braceOffset, sunset))
}

// Track visible character positions back to their HTML source. This lets a
// placeholder span bold/italic runs without touching attributes or dropping tags.
function expandHTML(html: string, sunset: number): string {
  let visible = ''
  const positions: { start: number; end: number }[] = []
  const parts = /<(?:[^>"']|"[^"]*"|'[^']*')*>|&(?:#x[\da-f]+|#\d+|[a-z]+);|[^<&]+|[<&]/gi
  for (const part of html.matchAll(parts)) {
    const source = part[0]
    const start = part.index!
    if (source.startsWith('<') && source.length > 1) {
      if (/^<\/?(?:p|div|br|li|img)\b/i.test(source)) {
        visible += '\ufffc'
        positions.push({ start, end: start })
      }
      continue
    }
    if (source.startsWith('&') && source.endsWith(';')) {
      const numeric = source.match(/^&#(x[\da-f]+|\d+);$/i)?.[1]
      const code = numeric ? numeric.toLowerCase().startsWith('x') ? parseInt(numeric.slice(1), 16) : Number(numeric) : NaN
      const decoded = source.toLowerCase() === '&nbsp;' ? ' ' : code >= 0 && code <= 127 ? String.fromCharCode(code) : '\ufffc'
      visible += decoded
      positions.push({ start, end: start + source.length })
    } else {
      visible += source
      for (let i = 0; i < source.length; i++) positions.push({ start: start + i, end: start + i + 1 })
    }
  }
  const edits: { start: number; end: number; value: string }[] = []
  for (const match of visible.matchAll(tokenPattern)) {
    const value = replacement(match[0], match[1], match[2], sunset)
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

export function expandTemplateSunset(text: string, html: string, date: string): { text: string; html: string } {
  if (!text.toLowerCase().includes('sunset') && !html.toLowerCase().includes('sunset')) return { text, html }
  const sunset = vancouverSunsetTimestamp(date)
  if (sunset === null) return { text, html }
  return {
    text: expand(text, sunset),
    html: expandHTML(html, sunset),
  }
}
