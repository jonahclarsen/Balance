// Native Tauri commands can reject with a string rather than an Error object.
// Keep that reason in synthetic CI diagnostics without retaining credentials.
export function cdpErrorMessage(details) {
  const reason = details.exception?.description
    ?? details.exception?.value
    ?? details.text
    ?? 'Unknown DevTools exception'
  return String(reason)
    .replace(/https?:\/\/[^\s"'<>]+/gi, '[redacted URL]')
    .replace(/BALSYNC1:[^\s"'<>]+/g, '[redacted pairing code]')
    .slice(0, 1000)
}
