<script lang="ts">
  import { situate, situateNow, mutateSituate } from './situate/store'
  import { regenerate, scheduleToday, timeZoneLocation, type Settings } from './situate/core'
  import { clockTime, inputTime, fromInputTime } from './situate/ui'
  let error = ''
  $: s = $situate.settings
  $: today = scheduleToday($situate, $situateNow)
  const location = timeZoneLocation()
  function save(patch: Partial<Settings>) {
    const settings = { ...$situate.settings, ...patch }
    mutateSituate(d => regenerate({ ...d, settings })).then(() => error = '').catch(e => error = String(e))
  }
</script>
<div class="schedule">
  <div class="fields">
    <label class="field"><span>Morning</span><input type="time" value={inputTime(s.wakeMinutes)} on:change={e => save({ wakeMinutes: fromInputTime(e.currentTarget.value) })} /></label>
    <div class="field"><span>Evening</span><div class="inline"><input type="time" value={inputTime(s.eveningMinutes)} on:change={e => save({ eveningMinutes: fromInputTime(e.currentTarget.value) })} />{#if location}<span title={`Sunset in ${location.name}`}>or sunset +</span><input class="short" type="number" min="0" max="24" step="0.5" value={s.sunsetOffset / 60} on:change={e => save({ sunsetOffset: Math.round(Number(e.currentTarget.value) * 60) })} /><span>h, if later</span>{/if}</div></div>
  </div>
  <div class="night">
    <h4>Touch grass at night</h4>
    <div class="inline">
      <span>Quiz passes last</span><input class="short" type="number" min="1" max="240" value={s.nightMinutes} aria-label="Night pass minutes" on:change={e => save({ nightMinutes: Number(e.currentTarget.value) })} /><span>min,</span>
      <input class="short" type="number" min="1" max="240" value={s.lateNightMinutes} aria-label="Late-night pass minutes" on:change={e => save({ lateNightMinutes: Number(e.currentTarget.value) })} /><span>min after</span>
      {#if location}<span title={`Sunset in ${location.name}`}>sunset +</span><input class="short" type="number" min="0" max="24" step="0.5" value={s.lateOffset / 60} aria-label="Hours after sunset" on:change={e => save({ lateOffset: Math.round(Number(e.currentTarget.value) * 60) })} /><span>h</span>
      {:else}<input type="time" value={inputTime(s.lateMinutes)} aria-label="Late-night time" on:change={e => save({ lateMinutes: fromInputTime(e.currentTarget.value) })} />{/if}
      {#if today}<span class="muted">({clockTime(today.late)} tonight)</span>{/if}
    </div>
  </div>
  <div class="inline"><span>Entertainment access lasts</span><input class="short" type="number" min="1" max="240" value={s.accessMinutes} aria-label="Entertainment access minutes" on:change={e => save({ accessMinutes: Number(e.currentTarget.value) })} /><span>min</span></div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
<style>
  .schedule { display:grid; gap:14px; }
  p { margin:0; font-size:13px; }
  .fields { display:grid; grid-template-columns:auto 1fr; gap:12px 24px; align-items:end; }
  .field { display:grid; gap:6px; font-size:13px; color:var(--muted); }
  .inline { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:13px; color:var(--muted); }
  input { color:var(--ink); }
  .short { width:64px; }
  .night { display:grid; gap:8px; padding:14px; border:1px solid var(--line); border-radius:12px; background:var(--paper-strong); }
  h4 { margin:0; font-size:14px; }
  .error { color:var(--danger); }
  @media (max-width:600px) { .fields { grid-template-columns:1fr; } }
</style>
