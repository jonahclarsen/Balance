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
  let expanded = false
  $: missing = status ? access.filter(item => !status![item.id]) : []
  $: if (status && missing.length === 0) expanded = false
  $: message = error || `${missing.length} ${missing.length === 1 ? 'permission' : 'permissions'} missing`

  async function refresh() {
    if (checking || document.hidden) return
    checking = true
    try {
      const result = JSON.parse(await invoke<string>('situate_permissions', { action: 'status' }))
      if (!result || access.some(item => typeof result[item.id] !== 'boolean') || typeof result.samsung !== 'boolean') throw new Error('Invalid permission status')
      if (!disposed) { status = result; error = '' }
    } catch {
      if (!disposed) { status = null; error = 'Couldn’t check device access' }
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

{#if missing.length || error}
  <section class="device-access" aria-label="Device access">
    <button class="summary" type="button" aria-label={message} aria-expanded={expanded} aria-controls="situate-missing-access" on:click={() => expanded = !expanded}>
      <span role="status">{message}</span>
      <svg class:expanded width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m6 9 6 6 6-6" /></svg>
    </button>
    {#if expanded}
      <div id="situate-missing-access" class="details">
        {#each status ? missing : access as item}
          <div class="access-row">
            <div><strong>{item.label}</strong><p>{item.effect}</p></div>
            <button type="button" aria-label={`Enable ${item.label}`} on:click={() => openSettings(item.id)}>Enable</button>
          </div>
        {/each}
        {#if status?.samsung}
          <p class="samsung">Samsung: set Balance’s battery use to <strong>Unrestricted</strong> and add it to <strong>Never sleeping apps</strong> in Battery → Background usage limits. Samsung’s sleeping-app setting can’t be checked here.</p>
        {/if}
        {#if actionError}<p role="alert">{actionError}</p>{/if}
        <button class="recheck" type="button" on:click={refresh} disabled={checking}>Recheck</button>
      </div>
    {/if}
  </section>
{/if}

<style>
  .device-access { margin-bottom:16px; border:1px solid color-mix(in srgb, var(--danger) 50%, var(--line)); border-radius:12px; background:var(--paper-strong); overflow:hidden; }
  button { flex:none; font-size:13px; padding:6px 12px; }
  .summary { display:flex; align-items:center; justify-content:space-between; gap:12px; width:100%; padding:12px 14px; border:0; border-radius:0; background:transparent; color:var(--danger); text-align:left; }
  .summary svg { flex:none; }
  .summary svg.expanded { transform:rotate(180deg); }
  .details { padding:0 14px 14px; }
  .access-row { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 0; border-top:1px solid var(--line); }
  .access-row > div { min-width:0; }
  strong { font-size:14px; }
  p { margin:4px 0 0; font-size:13px; }
  .samsung { border-top:1px solid var(--line); padding-top:12px; color:var(--muted); }
  .recheck { margin-top:12px; }
  [role="alert"] { color:var(--danger); }
</style>
