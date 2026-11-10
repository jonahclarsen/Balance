<script lang="ts">
  import { onMount } from 'svelte'
  import { invoke } from '@tauri-apps/api/core'

  const access = [
    { id: 'accessibility', label: 'Accessibility access', effect: 'Apps aren’t blocked.' },
    { id: 'notifications', label: 'Notification access', effect: 'Notifications aren’t silenced or saved.' },
    { id: 'usage', label: 'App detection access', effect: 'Missed app switches can’t be recovered.' },
    { id: 'mode-notifications', label: 'Mode notifications', effect: 'Mode changes and heads-ups won’t appear.' },
    { id: 'alarms', label: 'Schedule permission', effect: 'Scheduled changes may be delayed.' },
    { id: 'battery', label: 'Unrestricted battery use', effect: 'Android may interrupt Situate in the background.' },
  ] as const
  type Status = Record<typeof access[number]['id'], boolean> & { samsung: boolean }
  let status: Status | null = null
  let error = ''
  let actionError = ''
  let checking = false
  let disposed = false
  $: missing = status ? access.filter(item => !status![item.id]) : []

  async function refresh() {
    if (checking || document.hidden) return
    checking = true
    try {
      const result = JSON.parse(await invoke<string>('situate_permissions', { action: 'status' }))
      if (!result || access.some(item => typeof result[item.id] !== 'boolean') || typeof result.samsung !== 'boolean') throw new Error('Invalid permission status')
      if (!disposed) { status = result; error = '' }
    } catch {
      if (!disposed) { status = null; error = 'Couldn’t check device access. Retry or open Settings below.' }
    } finally { checking = false }
  }
  async function openSettings(action: string) {
    actionError = ''
    try { await invoke('situate_permissions', { action }) }
    catch { actionError = 'Couldn’t open Settings. Open Balance’s permissions in Android Settings.' }
  }
  onMount(() => {
    void refresh()
    const recheck = () => { void refresh() }
    window.addEventListener('focus', recheck)
    document.addEventListener('visibilitychange', recheck)
    const timer = window.setInterval(recheck, 5000)
    return () => {
      disposed = true
      window.clearInterval(timer)
      window.removeEventListener('focus', recheck)
      document.removeEventListener('visibilitychange', recheck)
    }
  })
</script>

<section class="device-access" class:missing={missing.length > 0 || !!error} aria-labelledby="device-access-heading">
  <div class="heading">
    <h3 id="device-access-heading">Device access</h3>
    <button type="button" on:click={refresh} disabled={checking}>Recheck</button>
  </div>
  <p class="summary" role="status">{error || (!status ? 'Checking access…' : missing.length ? 'Situate needs access' : 'All access granted')}</p>
  {#each access as item}
    <div class="access-row" class:needed={status && !status[item.id]}>
      <div><strong>{item.label}</strong><span>{status ? status[item.id] ? 'Granted' : 'Missing' : 'Not checked'}</span>
        {#if !status || !status[item.id]}<p>{item.effect}</p>{/if}
      </div>
      <button type="button" aria-label={`${status?.[item.id] ? 'Manage' : 'Enable'} ${item.label}`} on:click={() => openSettings(item.id)}>{status?.[item.id] ? 'Manage' : 'Enable'}</button>
    </div>
  {/each}
  {#if status?.samsung}
    <p class="samsung">Samsung: set Balance’s battery use to <strong>Unrestricted</strong> and add it to <strong>Never sleeping apps</strong> in Battery → Background usage limits. Samsung’s sleeping-app setting can’t be checked here.</p>
  {/if}
  {#if actionError}<p role="alert">{actionError}</p>{/if}
</section>

<style>
  .device-access { margin-bottom:20px; padding:16px; border:1px solid var(--line); border-radius:14px; background:var(--paper-strong); }
  .device-access.missing { border:2px solid var(--danger); }
  .heading { display:flex; align-items:center; justify-content:space-between; gap:12px; }
  h3 { margin:0; font-size:1.05rem; }
  button { flex:none; font-size:13px; padding:6px 12px; }
  .summary { margin:8px 0; font-weight:650; }
  .missing .summary, .needed span, [role="alert"] { color:var(--danger); }
  .access-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-top:1px solid var(--line); }
  .access-row > div { min-width:0; }
  strong { font-size:14px; }
  span { display:block; font-size:12px; color:var(--muted); }
  p { margin:4px 0 0; font-size:13px; }
  .samsung { border-top:1px solid var(--line); padding-top:12px; color:var(--muted); }
</style>
