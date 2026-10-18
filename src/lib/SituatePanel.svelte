<script lang="ts">
  import { isTauri, invoke } from '@tauri-apps/api/core'
  import { situate, situateNow, situatePlatform, situateError, mutateSituate, requestQuiz, activateMode } from './situate/store'
  import { isActive, epoch, regenerate, type Mode, type Settings, type Category, type Target } from './situate/core'
  import OverlayModal from './OverlayModal.svelte'
  import SituateQuestionEditor from './SituateQuestionEditor.svelte'
  import SituateNotifications from './SituateNotifications.svelte'
  let editing: Mode | null = null
  let settings: Settings | null = null
  let error = ''
  let newCategory: Category = 'custom'
  let newKind: Target['kind'] = 'domain'
  let newTarget = ''
  let permissions = ''
  let saving = false
  $: currentEpoch = epoch($situate, $situateNow)
  $: countdown = $situate.grants.find(g => g.mode === 'touch-grass' && !g.target && g.until > $situateNow && currentEpoch?.phase === 'night')
  function edit(mode: Mode) { editing = structuredClone(mode); error = '' }
  function time(minutes: number) { return `${String(Math.floor(minutes / 60)).padStart(2,'0')}:${String(minutes % 60).padStart(2,'0')}` }
  function minutes(value: string) { const [h,m] = value.split(':').map(Number); return h * 60 + m }
  async function saveMode() {
    if (!editing) return
    saving = true
    const mode = structuredClone(editing)
    try { await mutateSituate(d => ({ ...d, modes: d.modes.some(m => m.id === mode.id) ? d.modes.map(m => m.id === mode.id ? mode : m) : [...d.modes, mode] })); editing = null } catch(e) { error = String(e) } finally { saving = false }
  }
  async function saveSettings() {
    if (!settings) return
    saving = true
    const value = structuredClone(settings)
    try { await mutateSituate(d => regenerate({ ...d, settings: value, grants: [] })); settings = null } catch(e) { error = String(e) } finally { saving = false }
  }
  function addMode() { edit({ id: crypto.randomUUID(), name: 'New mode', platforms: [situatePlatform], categories: ['custom'], scheduled: false, dayQuiz: [{ id: 'reason', text: 'Do you have a reason to continue?', required: true }], nightQuiz: [{ id: 'reason', text: 'Do you have a reason to continue?', required: true }], accessQuiz: [], targets: [] }) }
  function addTarget() {
    if (!editing || !newTarget.trim()) return
    const value = newTarget.trim().toLowerCase()
    editing = { ...editing, targets: [...editing.targets.filter(t => t.id !== `${newKind}:${value}`), { id: `${newKind}:${value}`, kind: newKind, category: newCategory, value }] }
    newTarget = ''
  }
  async function permissionsAction(action: string) {
    try { permissions = await invoke<string>('situate_permissions', { action }) } catch(e) { permissions = String(e) }
  }
</script>
<section class="situate-panel">
  <header><div><h1>Situate</h1></div><button type="button" on:click={() => { settings = structuredClone($situate.settings); error = '' }}>Schedule</button></header>
  {#if $situateError}<p role="alert">{$situateError}</p>{/if}
  {#if !$situate.enabled}<div class="intro"><h2>Pause before scrolling.</h2><p>Dolo and Touch grass start together. Review their rules below.</p><button type="button" on:click={() => mutateSituate(d => ({ ...d, enabled: true })).catch(() => {})}>Enable Situate</button></div>{/if}
  {#if countdown}<div class="countdown" role="timer"><strong>{Math.ceil((countdown.until - $situateNow) / 60000)} minutes</strong><span>Touch grass comes back on at {new Date(countdown.until).toLocaleTimeString([], { hour:'numeric', minute:'2-digit' })}</span></div>{/if}
  <div class="modes">
  {#each $situate.modes as mode (mode.id)}
    {@const active = isActive($situate, mode, situatePlatform, $situateNow)}
    <article class:active><div class="mode-heading"><h2>{mode.name}</h2><span class="status">{active ? 'On' : 'Off'}</span></div><p class="muted">{mode.targets.length} apps & sites · {mode.platforms.join(' · ')}</p><p>{mode.scheduled ? 'Wake time + evening' : 'Manual'}</p>
      <div class="actions"><button type="button" disabled={!mode.platforms.includes(situatePlatform)} on:click={() => active ? requestQuiz(mode.id) : activateMode(mode.id).catch(() => {})}>{active ? `Turn off ${mode.name}` : `Turn on ${mode.name}`}</button><button type="button" on:click={() => edit(mode)}>Edit {mode.name}</button></div>
      {#if active && mode.targets.some(t => t.category === 'entertainment')}<details><summary>Entertainment access</summary><div class="target-buttons">{#each mode.targets.filter(t => t.category === 'entertainment') as target}<button type="button" on:click={() => requestQuiz(mode.id, target.id)}>{target.value}</button>{/each}</div></details>{/if}
    </article>
  {/each}
  </div>
  <button type="button" on:click={addMode}>Add blocking mode</button>
  <section class="setup"><h2>Device setup</h2>
    {#if !isTauri()}<p>This browser preview demonstrates the rules and quizzes. Open the installed Balance app to block apps and collect notifications.</p>
    {:else if situatePlatform === 'android'}<p>Allow notification access to save and silence notifications, and accessibility access to redirect blocked apps. Balance reads app identities, never screen text.</p><div class="actions"><button type="button" on:click={() => permissionsAction('notifications')}>Notification access</button><button type="button" on:click={() => permissionsAction('accessibility')}>App blocking access</button><button type="button" on:click={() => permissionsAction('alarms')}>Schedule permission</button></div>
    {:else}<p>Keep Balance running for app blocking and activation notifications. Install the Situate Chrome extension for websites. Herdr and Cactus can read the optional Situate-only status feed.</p><button type="button" on:click={() => permissionsAction('status')}>Check device setup</button>{/if}
    {#if permissions}<p role="status">{permissions}</p>{/if}
    <p class="muted">Local rules. No browsing history or saved answers. Android history is encrypted and never synced.</p>
  </section>
  {#if situatePlatform === 'android'}<SituateNotifications />{/if}
</section>
{#if editing}
<OverlayModal title={`Edit ${editing.name}`} onClose={() => editing = null} maxWidth={850}>
  <label>Name<input bind:value={editing.name} maxlength="100" /></label>
  <fieldset><legend>Devices</legend>{#each ['mac','android'] as platform}<label class="inline"><input type="checkbox" checked={editing.platforms.includes(platform as typeof situatePlatform)} on:change={e => { if (editing) editing.platforms = e.currentTarget.checked ? [...editing.platforms, platform as typeof situatePlatform] : editing.platforms.filter(p => p !== platform) }} />{platform}</label>{/each}</fieldset>
  <label class="inline"><input type="checkbox" bind:checked={editing.scheduled} />Turn on at wake time and evening</label>
  <SituateQuestionEditor label="Turn off during the day" bind:questions={editing.dayQuiz} />
  <SituateQuestionEditor label="Turn off at night" bind:questions={editing.nightQuiz} />
  <SituateQuestionEditor label="Entertainment access" bind:questions={editing.accessQuiz} />
  <h3>Blocked apps & websites</h3><p class="muted">Domains include subdomains. Apps use macOS bundle IDs or Android package IDs. Discord entries use exact channel/thread IDs; other Discord conversations remain available.</p>
  <div class="targets">{#each editing.targets as target}<div><span>{target.value} <small>({target.category})</small></span><button type="button" aria-label={`Remove ${target.value}`} on:click={() => { if (editing) editing.targets = editing.targets.filter(t => t.id !== target.id) }}><svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" stroke="currentColor" stroke-width="2"/></svg></button></div>{/each}</div>
  <div class="add-target"><label>Type<select bind:value={newKind}><option value="domain">Website</option><option value="app">App</option><option value="discord">Discord thread/channel</option></select></label><label>Category<select bind:value={newCategory}><option value="social">Social</option><option value="entertainment">Entertainment</option><option value="ai">AI</option><option value="custom">Custom</option></select></label><label>Identifier<input bind:value={newTarget} placeholder="youtube.com" /></label><button type="button" on:click={addTarget}>Add</button></div>
  {#if error}<p role="alert">{error}</p>{/if}<button type="button" disabled={saving} on:click={saveMode}>Save mode</button>
</OverlayModal>
{/if}
{#if settings}
<OverlayModal title="Situate schedule" onClose={() => settings = null} maxWidth={650}>
  <div class="schedule"><label>New day begins<input type="time" value={time(settings.wakeMinutes)} on:input={e => { if(settings) settings.wakeMinutes = minutes(e.currentTarget.value) }} /></label>
  <h3>Evening begins at the later of</h3><label>Clock time<input type="time" value={time(settings.eveningMinutes)} on:input={e => { if(settings) settings.eveningMinutes = minutes(e.currentTarget.value) }} /></label><label>Minutes after sunset<input type="number" min="0" max="1440" bind:value={settings.sunsetOffset} /></label>
  <h3>Shorter passes begin</h3><label>Minutes after sunset (rounded to 30 minutes)<input type="number" min="0" max="1440" bind:value={settings.lateOffset} /></label><label>Fallback time without a location<input type="time" value={time(settings.lateMinutes)} on:input={e => { if(settings) settings.lateMinutes = minutes(e.currentTarget.value) }} /></label>
  <p class="muted">Optional approximate location, calculated offline. Without one, the clock times apply. During polar day/night, clock times are used too.</p>
  <label>Latitude<input type="number" min="-90" max="90" step="0.01" value={settings.latitude ?? ''} on:input={e => { if(settings) settings.latitude = e.currentTarget.value === '' ? null : Number(e.currentTarget.value) }} /></label><label>Longitude<input type="number" min="-180" max="180" step="0.01" value={settings.longitude ?? ''} on:input={e => { if(settings) settings.longitude = e.currentTarget.value === '' ? null : Number(e.currentTarget.value) }} /></label>
  <label>Night pass (minutes)<input type="number" min="1" max="240" bind:value={settings.nightMinutes} /></label><label>Late-night pass (minutes)<input type="number" min="1" max="240" bind:value={settings.lateNightMinutes} /></label><label>Entertainment access (minutes)<input type="number" min="1" max="240" bind:value={settings.accessMinutes} /></label>
  <p class="muted">Changing the schedule ends existing passes. Your planner’s day boundary stays unchanged.</p></div>
  {#if error}<p role="alert">{error}</p>{/if}<button type="button" disabled={saving} on:click={saveSettings}>Save schedule</button>
</OverlayModal>
{/if}
<style>
.situate-panel { max-width:1000px; margin:0 auto; padding:24px; } header,.mode-heading { display:flex; justify-content:space-between; align-items:center; gap:16px; } h1 { font-size:2rem; margin:8px 0 24px; } .modes { display:grid; grid-template-columns:repeat(auto-fit,minmax(260px,1fr)); gap:16px; margin:24px 0; } article,.intro,.countdown,.setup { border:1px solid var(--border); border-radius:18px; padding:22px; } article.active { border-color:var(--accent); } h2 { margin:0; font-size:1.2rem; } .status { border-radius:999px; border:1px solid currentColor; padding:3px 10px; font-size:.8rem; } .actions,.target-buttons { display:flex; flex-wrap:wrap; gap:8px; } details { margin-top:18px; } .target-buttons { margin-top:12px; } .setup { margin-top:32px; } .countdown { display:flex; flex-direction:column; gap:8px; } .countdown strong { font-size:2rem; font-variant-numeric:tabular-nums; } label { display:grid; gap:6px; margin:12px 0; } .inline { display:inline-flex; align-items:center; margin-right:16px; } .targets { max-height:240px; overflow:auto; } .targets > div { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:5px; } .targets span { overflow-wrap:anywhere; } .add-target { display:flex; flex-wrap:wrap; align-items:end; gap:10px; } .schedule { display:grid; grid-template-columns:1fr 1fr; gap:0 20px; } .schedule h3,.schedule p { grid-column:1 / -1; } input,select { min-width:0; width:100%; } input[type=checkbox] { width:auto; } @media(max-width:600px) { .situate-panel { padding:16px 6px; } .schedule { grid-template-columns:1fr; } }
</style>
