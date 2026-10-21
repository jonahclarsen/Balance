<script lang="ts">
  import { situate, situateNow, mutateSituate } from './situate/store'
  import { regenerate, scheduleToday, type Settings } from './situate/core'
  import { clockTime, inputTime, fromInputTime } from './situate/ui'
  let error = ''
  $: s = $situate.settings
  $: today = scheduleToday($situate, $situateNow)
  $: span = today ? today.nextWake - today.wake : 1
  $: at = (time: number) => today ? `${Math.min(100, Math.max(0, (time - today.wake) / span * 100))}%` : '0%'
  $: located = s.latitude !== null && s.longitude !== null
  function save(patch: Partial<Settings>) {
    const settings = { ...$situate.settings, ...patch }
    mutateSituate(d => regenerate({ ...d, settings })).then(() => error = '').catch(e => error = String(e))
  }
  const number = (value: string) => value === '' ? null : Number(value)
</script>
<div class="schedule">
  {#if today}
    <div class="timeline" aria-hidden="true">
      <div class="bar"><span class="day" style:width={at(today.evening)}></span><span class="late" style:left={at(today.late)}></span><span class="now" style:left={at($situateNow)}></span></div>
      <div class="labels">
        <span style:left="0">☀ {clockTime(today.wake)}</span>
        <span style:left={at(today.evening)}>☾ {clockTime(today.evening)}</span>
        <span class="end">{clockTime(today.nextWake)}</span>
      </div>
    </div>
  {/if}
  <p class="muted">Scheduled modes turn on at morning and evening. A quiz turns one off until the next.</p>
  <div class="fields">
    <label class="field"><span>Morning</span><input type="time" value={inputTime(s.wakeMinutes)} on:change={e => save({ wakeMinutes: fromInputTime(e.currentTarget.value) })} /></label>
    <div class="field"><span>Evening</span><div class="inline"><input type="time" value={inputTime(s.eveningMinutes)} on:change={e => save({ eveningMinutes: fromInputTime(e.currentTarget.value) })} />{#if located}<span>or sunset +</span><input class="short" type="number" min="0" max="24" step="0.5" value={s.sunsetOffset / 60} on:change={e => save({ sunsetOffset: Math.round(Number(e.currentTarget.value) * 60) })} /><span>h, if later</span>{/if}</div></div>
    <div class="field"><span>Location <em>for sunset</em></span><div class="inline"><input class="coord" type="number" min="-90" max="90" step="0.01" placeholder="Latitude" aria-label="Latitude" value={s.latitude ?? ''} on:change={e => save({ latitude: number(e.currentTarget.value) })} /><input class="coord" type="number" min="-180" max="180" step="0.01" placeholder="Longitude" aria-label="Longitude" value={s.longitude ?? ''} on:change={e => save({ longitude: number(e.currentTarget.value) })} /></div></div>
  </div>
  <div class="night">
    <h4>Touch grass at night</h4>
    <div class="inline">
      <span>Quiz passes last</span><input class="short" type="number" min="1" max="240" value={s.nightMinutes} aria-label="Night pass minutes" on:change={e => save({ nightMinutes: Number(e.currentTarget.value) })} /><span>min,</span>
      <input class="short" type="number" min="1" max="240" value={s.lateNightMinutes} aria-label="Late-night pass minutes" on:change={e => save({ lateNightMinutes: Number(e.currentTarget.value) })} /><span>min after</span>
      {#if located}<span>sunset +</span><input class="short" type="number" min="0" max="24" step="0.5" value={s.lateOffset / 60} aria-label="Hours after sunset" on:change={e => save({ lateOffset: Math.round(Number(e.currentTarget.value) * 60) })} /><span>h</span>
      {:else}<input type="time" value={inputTime(s.lateMinutes)} aria-label="Late-night time" on:change={e => save({ lateMinutes: fromInputTime(e.currentTarget.value) })} />{/if}
      {#if today}<span class="muted">({clockTime(today.late)} tonight)</span>{/if}
    </div>
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
<style>
  .schedule { display:grid; gap:14px; }
  .timeline { padding:2px 0 4px; }
  .bar { position:relative; height:12px; border-radius:999px; background:color-mix(in srgb, #3c4a8c 32%, var(--paper)); overflow:visible; }
  .day { position:absolute; inset:0 auto 0 0; border-radius:999px 0 0 999px; background:color-mix(in srgb, #e8b33a 55%, var(--paper)); }
  .late { position:absolute; top:-3px; bottom:-3px; width:2px; background:color-mix(in srgb, #3c4a8c 70%, var(--ink)); }
  .now { position:absolute; top:-5px; width:4px; height:22px; margin-left:-2px; border-radius:2px; background:var(--ink); box-shadow:0 0 0 2px var(--paper); }
  .labels { position:relative; height:18px; margin-top:6px; font-size:12px; color:var(--muted); }
  .labels span { position:absolute; white-space:nowrap; transform:translateX(-50%); }
  .labels span:first-child { transform:none; }
  .labels .end { right:0; transform:none; }
  p { margin:0; font-size:13px; }
  .fields { display:grid; grid-template-columns:auto 1fr; gap:12px 24px; align-items:end; }
  .fields .field:last-child { grid-column:1 / -1; }
  .field { display:grid; gap:6px; font-size:13px; color:var(--muted); }
  em { font-style:normal; opacity:.75; }
  .inline { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:13px; color:var(--muted); }
  input { color:var(--ink); }
  .short { width:64px; }
  .coord { width:120px; }
  .night { display:grid; gap:8px; padding:14px; border:1px solid var(--line); border-radius:12px; background:var(--paper-strong); }
  h4 { margin:0; font-size:14px; }
  .error { color:var(--danger); }
  @media (max-width:600px) { .fields { grid-template-columns:1fr; } }
</style>
