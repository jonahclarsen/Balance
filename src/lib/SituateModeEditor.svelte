<script lang="ts">
  import { onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import OverlayModal from './OverlayModal.svelte'
  import SituateQuestionEditor from './SituateQuestionEditor.svelte'
  import SituateTargets from './SituateTargets.svelte'
  import SituateIcon from './SituateIcon.svelte'
  import { situate, situateNow, mutateSituate } from './situate/store'
  import { MODE_COLORS, scheduleToday, validate, type Mode } from './situate/core'
  import { DEVICES, clockTime } from './situate/ui'
  export let mode: Mode
  export let onClose: () => void
  let draft: Mode = structuredClone(mode)
  let saved = JSON.stringify(draft)
  let error = ''
  let timer: number | undefined
  $: today = scheduleToday($situate, $situateNow)
  // Every edit saves shortly after it is made; closing flushes the last one.
  $: queue(draft)
  function queue(value: Mode) {
    if (JSON.stringify(value) === saved) return
    window.clearTimeout(timer)
    timer = window.setTimeout(flush, 300)
  }
  function flush() {
    window.clearTimeout(timer)
    const value = structuredClone(draft)
    const raw = JSON.stringify(value)
    if (raw === saved) return
    const current = get(situate)
    try { validate({ ...current, modes: current.modes.map(m => m.id === value.id ? value : m) }); error = '' } catch (e) { error = e instanceof Error ? e.message : String(e); return }
    saved = raw
    mutateSituate(d => ({ ...d, modes: d.modes.map(m => m.id === value.id ? value : m) })).catch(e => { error = String(e); saved = '' })
  }
  onDestroy(flush)
  function toggleDevice(id: Mode['platforms'][number]) {
    const on = draft.platforms.includes(id)
    if (on && draft.platforms.length === 1) return
    draft.platforms = on ? draft.platforms.filter(p => p !== id) : [...draft.platforms, id]
  }
</script>
<OverlayModal title={draft.name || 'Mode'} ariaLabel={`Edit ${mode.name}`} eyebrow="Mode" onClose={() => { flush(); onClose() }} maxWidth={760}>
  <div class="editor" style:--mode={draft.color}>
    <section>
      <h3>Basics</h3>
      <div class="basics">
        <label class="field">Name<input bind:value={draft.name} maxlength="100" /></label>
        <div class="field"><span>Color</span><div class="swatches" role="group" aria-label="Color">{#each MODE_COLORS as color}<button type="button" class="swatch" style:--swatch={color} aria-label={color} aria-pressed={draft.color === color} on:click={() => draft.color = color}></button>{/each}</div></div>
        <div class="field"><span>Devices</span><div class="devices" role="group" aria-label="Devices">{#each DEVICES as device}{@const on = draft.platforms.includes(device.id)}<button type="button" aria-pressed={on} disabled={on && draft.platforms.length === 1} title={on && draft.platforms.length === 1 ? 'A mode needs at least one device' : undefined} on:click={() => toggleDevice(device.id)}><SituateIcon name={device.id} />{device.label}</button>{/each}</div></div>
      </div>
    </section>
    <section>
      <h3>Turns on</h3>
      <div class="devices" role="group" aria-label="Turns on">
        <button type="button" aria-pressed={draft.scheduled} on:click={() => draft.scheduled = true}>Morning and evening</button>
        <button type="button" aria-pressed={!draft.scheduled} on:click={() => draft.scheduled = false}>Only by hand</button>
      </div>
      <p class="muted">{draft.scheduled && today ? `Today at ${clockTime(today.wake)} and ${clockTime(today.evening)}. A quiz turns it off until the next one.` : 'Stays on until a quiz turns it off.'}</p>
    </section>
    <section>
      <h3>Quiz to turn off</h3>
      <div class="quizzes">
        <SituateQuestionEditor label="Day" hint={today ? `${clockTime(today.wake)}–${clockTime(today.evening)}` : ''} bind:questions={draft.dayQuiz} />
        <SituateQuestionEditor label="Night" hint={today ? `${clockTime(today.evening)}–${clockTime(today.nextWake)}` : ''} bind:questions={draft.nightQuiz} />
        <SituateQuestionEditor label="Entertainment access" hint={`One site, ${$situate.settings.accessMinutes} min`} bind:questions={draft.accessQuiz} />
      </div>
    </section>
    <section>
      <h3>Blocked <span class="count">{draft.targets.length}</span></h3>
      <SituateTargets bind:targets={draft.targets} />
    </section>
    {#if error}<p class="error" role="alert">{error}</p>{/if}
  </div>
</OverlayModal>
<style>
  .editor { display:grid; }
  section { display:grid; gap:10px; padding:18px 0; }
  section:first-child { padding-top:4px; }
  section + section { border-top:1px solid var(--line); }
  h3 { margin:0; font-size:15px; display:flex; align-items:center; gap:8px; }
  .count { font-size:12px; font-weight:600; color:var(--muted); background:var(--active-nav); border-radius:999px; padding:1px 8px; }
  .basics { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:12px 20px; align-items:end; }
  .basics .field:first-child { grid-column:1 / -1; }
  .field { display:grid; gap:6px; font-size:13px; color:var(--muted); }
  .field input { color:var(--ink); font-size:14px; }
  .swatches { display:flex; gap:6px; flex-wrap:wrap; }
  .swatch { width:26px; height:26px; padding:0; border-radius:50%; background:var(--swatch); border:2px solid var(--paper-strong); box-shadow:0 0 0 1px var(--line); }
  .swatch[aria-pressed='true'] { box-shadow:0 0 0 2px var(--swatch); }
  .devices { display:inline-flex; flex-wrap:wrap; gap:6px; }
  .devices button { display:inline-flex; align-items:center; gap:7px; padding:6px 12px; font-size:14px; border-radius:999px; color:var(--muted); }
  .devices button[aria-pressed='true'] { color:var(--ink); border-color:var(--mode); background:color-mix(in srgb, var(--mode) 12%, transparent); font-weight:600; }
  .devices button:disabled { cursor:default; opacity:1; }
  p.muted { margin:0; font-size:13px; }
  .quizzes { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
  .error { margin:0; color:var(--danger); }
  @media (max-width:640px) { .quizzes, .basics { grid-template-columns:1fr; } }
</style>
