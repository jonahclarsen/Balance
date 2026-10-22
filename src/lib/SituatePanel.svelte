<script lang="ts">
  import { isTauri, invoke } from '@tauri-apps/api/core'
  import { situate, situateNow, situatePlatform, situateError, requestQuiz, activateMode } from './situate/store'
  import { isActive, epoch, backOn, nextScheduled, scheduleToday, type Mode } from './situate/core'
  import { DEVICES, clockTime } from './situate/ui'
  import { formatMinutes as minutesTime } from './planner'
  import { browsersMissingExtension, extensionSetupOpen } from './situate/extension'
  import SituateModeEditor from './SituateModeEditor.svelte'
  import SituateSchedule from './SituateSchedule.svelte'
  import SituateAccess from './SituateAccess.svelte'
  import SituateIcon from './SituateIcon.svelte'
  import SituateNotifications from './SituateNotifications.svelte'
  let editing: Mode | null = null
  let permissions = ''
  $: modes = $situate.modes.filter(m => m.platforms.includes(situatePlatform))
  $: currentEpoch = epoch($situate, $situateNow)
  $: today = scheduleToday($situate, $situateNow)
  $: countdown = currentEpoch && $situate.grants.find(g => g.mode === 'touch-grass' && !g.target && g.until > $situateNow && (currentEpoch!.phase === 'night' || g.until < currentEpoch!.end))
  function nightPass(mode: Mode) {
    if (mode.id !== 'touch-grass' || currentEpoch?.phase !== 'night') return 0
    return $situateNow >= currentEpoch.late ? $situate.settings.lateNightMinutes : $situate.settings.nightMinutes
  }
  function summary(mode: Mode, active: boolean) {
    if (mode.reminder) return `${minutesTime(mode.reminder.from)}–${minutesTime(mode.reminder.until)}`
    if (!active) {
      const until = backOn($situate, mode, $situateNow)
      return until ? `Back on at ${clockTime(until)}` : 'Off until you turn it on'
    }
    const minutes = nightPass(mode)
    if (minutes) return `A quiz turns it off for ${minutes} min`
    const until = nextScheduled($situate, mode, $situateNow)
    return until ? `A quiz turns it off until ${clockTime(until)}` : 'A quiz turns it off'
  }
  async function permissionsAction(action: string) {
    try { permissions = await invoke<string>('situate_permissions', { action }) } catch(e) { permissions = String(e) }
  }
</script>
<section class="situate-panel" data-native-undo>
  <header class="page-header"><div><h2>Situate</h2></div></header>
  {#if $situateError}<p class="error" role="alert">{$situateError}</p>{/if}
  {#if $browsersMissingExtension.length}
    <button type="button" class="extension-alert" on:click={() => extensionSetupOpen.set(true)}>
      <span class="alert-icon" aria-hidden="true">!</span>
      <span><strong>Websites aren’t blocked in {$browsersMissingExtension.map(b => b.name).join(' or ')}</strong><span>Install the Situate extension</span></span>
      <span class="alert-action">Set up</span>
    </button>
  {/if}
  {#if countdown}<div class="countdown" role="timer"><strong>{Math.ceil((countdown.until - $situateNow) / 60000)} min</strong><span>Touch grass is back on at {clockTime(countdown.until)}</span></div>{/if}

  <section class="block">
    <h3>Modes</h3>
    <div class="modes">
      {#each modes as mode (mode.id)}
        {@const active = isActive($situate, mode, situatePlatform, $situateNow)}
        <article class:active style:--mode={mode.color}>
          <div class="mode-heading"><h4>{mode.name}</h4><span class="status">{active ? 'On' : 'Off'}</span></div>
          {#if mode.description}<p class="description">{mode.description}</p>{/if}
          <p class="meta">
            {#each DEVICES.filter(d => mode.platforms.includes(d.id)) as device}<span title={device.label}><SituateIcon name={device.id} size={14} /><span class="sr-only">{device.label}</span></span>{/each}
          </p>
          <p class="when">{summary(mode, active)}</p>
          <div class="actions">
            {#if !mode.reminder}<button type="button" aria-label={`${active ? 'Turn off' : 'Turn on'} ${mode.name}`} on:click={() => active ? requestQuiz(mode.id) : activateMode(mode.id).catch(() => {})}>{active ? 'Turn off' : 'Turn on'}</button>{/if}
            <button type="button" aria-label={`Edit ${mode.name}`} on:click={() => editing = structuredClone(mode)}>Edit</button>
          </div>
        </article>
      {/each}
    </div>
    <!-- Adding modes is paused for now.
    <button type="button" on:click={addMode}>Add blocking mode</button> -->
  </section>

  <section class="block"><h3>Schedule</h3><SituateSchedule /></section>

  <section class="block"><h3>Entertainment access</h3><SituateAccess /></section>

  {#if isTauri() && situatePlatform === 'android'}
    <section class="block">
      <h3>Device access</h3>
      <div class="actions"><button type="button" on:click={() => permissionsAction('notifications')}>Notification access</button><button type="button" on:click={() => permissionsAction('mode-notifications')}>Mode notifications</button><button type="button" on:click={() => permissionsAction('accessibility')}>App blocking access</button><button type="button" on:click={() => permissionsAction('alarms')}>Schedule permission</button></div>
      {#if permissions}<p role="status" class="muted">{permissions}</p>{/if}
    </section>
    <section class="block"><SituateNotifications /></section>
  {/if}
</section>
{#if editing}<SituateModeEditor mode={editing} onClose={() => editing = null} />{/if}
<style>
  .situate-panel { max-width:1000px; margin:0 auto; padding:24px; }
  .error { color:var(--danger); }
  .extension-alert { display:flex; align-items:center; gap:14px; width:100%; text-align:left; padding:14px 16px; margin-bottom:16px; border:1.5px solid var(--danger); border-radius:14px; background:color-mix(in srgb, var(--danger) 10%, var(--paper)); color:var(--ink); }
  .extension-alert:hover { background:color-mix(in srgb, var(--danger) 15%, var(--paper)); border-color:var(--danger); }
  .extension-alert > span:nth-child(2) { display:grid; gap:2px; flex:1; }
  .extension-alert > span:nth-child(2) > span { color:var(--muted); font-size:13px; }
  .alert-icon { display:grid; place-items:center; flex:none; width:28px; height:28px; border-radius:50%; background:var(--danger); color:white; font-weight:800; }
  .alert-action { flex:none; padding:6px 14px; border-radius:999px; background:var(--danger); color:white; font-weight:650; font-size:13px; }
  .countdown { display:flex; align-items:baseline; gap:12px; padding:14px 18px; margin-bottom:16px; border:1px solid var(--line); border-radius:14px; }
  .countdown strong { font-size:1.6rem; font-variant-numeric:tabular-nums; }
  .block { padding:20px 0; }
  .block + .block { border-top:1px solid var(--line); }
  h3 { margin:0 0 14px; font-size:1.05rem; }
  .modes { display:grid; grid-template-columns:repeat(auto-fill,minmax(260px,1fr)); gap:14px; }
  article { position:relative; display:grid; gap:8px; padding:16px 18px 16px 22px; border:1px solid var(--line); border-radius:14px; background:var(--paper-strong); overflow:hidden; }
  article.active::before { content:''; position:absolute; inset:0 auto 0 0; width:5px; background:var(--mode); }
  article.active { border-color:color-mix(in srgb, var(--mode) 55%, var(--line)); background:color-mix(in srgb, var(--mode) 6%, var(--paper-strong)); }
  .mode-heading { display:flex; align-items:center; gap:8px; }
  h4 { margin:0; font-size:1.1rem; flex:1; }
  .status { border-radius:999px; padding:2px 10px; font-size:12px; font-weight:650; color:var(--muted); border:1px solid var(--line); }
  .active .status { color:white; background:var(--mode); border-color:var(--mode); }
  .meta { display:flex; align-items:center; gap:8px; margin:0; color:var(--muted); font-size:13px; }
  .meta > span:first-child, .meta > span { display:inline-flex; align-items:center; gap:4px; }
  .when { margin:0; font-size:13px; }
  .description { margin:0; font-size:13px; color:var(--muted); white-space:pre-line; }
  .actions { display:flex; flex-wrap:wrap; gap:8px; margin-top:4px; }
  article .actions button { font-size:14px; padding:6px 12px; }
  .sr-only { position:absolute; width:1px; height:1px; overflow:hidden; clip:rect(0 0 0 0); }
  @media(max-width:600px) { .situate-panel { padding:16px 6px; } }
</style>
