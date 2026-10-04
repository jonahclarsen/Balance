import { invoke, isTauri } from '@tauri-apps/api/core'

/** Only booleans and fixed event names cross this boundary, never editor values. */
export function startFreezeDiagnostics(): () => void {
  if (!isTauri()) return () => {}
  let stopped = false
  let pending = false
  let composing = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const pulse = () => {
    if (stopped || pending) return
    pending = true
    const active = document.activeElement
    void invoke('record_freeze_diagnostic', { event: {
      event: 'webview_pulse', visible: document.visibilityState === 'visible',
      editor_focused: active instanceof HTMLElement && (active.isContentEditable || active.matches('textarea,input')),
      composing,
    } }).catch(() => {}).finally(() => {
      pending = false
      if (!stopped && document.visibilityState === 'visible') timer = setTimeout(pulse, 5000)
    })
  }
  const signal = (event: 'javascript_error' | 'unhandled_rejection' | 'window_focus', focused?: boolean) => {
    // Deliberately discard ErrorEvent.message, rejection reasons and stacks.
    void invoke('record_freeze_diagnostic', { event: focused === undefined ? {event} : {event, focused} }).catch(() => {})
  }
  const error = () => signal('javascript_error')
  const rejection = () => signal('unhandled_rejection')
  const focus = () => { signal('window_focus', true); changed() }
  const blur = () => { signal('window_focus', false); changed() }
  const changed = () => { if (timer) clearTimeout(timer); pulse() }
  const compositionStart = () => { composing = true; changed() }
  const compositionEnd = () => { composing = false; changed() }
  window.addEventListener('error', error)
  window.addEventListener('unhandledrejection', rejection)
  window.addEventListener('focus', focus)
  window.addEventListener('blur', blur)
  document.addEventListener('visibilitychange', changed)
  document.addEventListener('focusin', changed)
  document.addEventListener('focusout', changed)
  document.addEventListener('compositionstart', compositionStart)
  document.addEventListener('compositionend', compositionEnd)
  pulse()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
    window.removeEventListener('error', error)
    window.removeEventListener('unhandledrejection', rejection)
    window.removeEventListener('focus', focus)
    window.removeEventListener('blur', blur)
    document.removeEventListener('visibilitychange', changed)
    document.removeEventListener('focusin', changed)
    document.removeEventListener('focusout', changed)
    document.removeEventListener('compositionstart', compositionStart)
    document.removeEventListener('compositionend', compositionEnd)
  }
}
