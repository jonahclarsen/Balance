<script lang="ts">
  import { situate, situateNow, mutateSituate } from './situate/store'
  import { regenerate, scheduleToday, timeZoneLocation, type Settings } from './situate/core'
  import { clockTime } from './situate/ui'
  import SituateDragValue from './SituateDragValue.svelte'
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
    <div class="field"><span>Morning</span><div class="inline"><SituateDragValue kind="clock" label="Morning" value={s.wakeMinutes} onChange={v => save({ wakeMinutes: v })} /></div></div>
    <div class="field"><span>Evening</span><div class="inline"><SituateDragValue kind="clock" label="Evening" value={s.eveningMinutes} onChange={v => save({ eveningMinutes: v })} />{#if location}<span title={`Sunset in ${location.name}`}>or sunset +</span><SituateDragValue kind="duration" min={0} label="Hours after sunset for evening" value={s.sunsetOffset} onChange={v => save({ sunsetOffset: v })} /><span>if later</span>{/if}</div></div>
  </div>
  <div class="night">
    <h4>Touch grass at night</h4>
    <div class="inline">
      <span>Quiz passes last</span><SituateDragValue kind="minutes" max={240} label="Night pass" value={s.nightMinutes} onChange={v => save({ nightMinutes: v })} /><span>then</span>
      <SituateDragValue kind="minutes" max={240} label="Late-night pass" value={s.lateNightMinutes} onChange={v => save({ lateNightMinutes: v })} />
      {#if location}<span title={`Sunset in ${location.name}`}>after sunset +</span><SituateDragValue kind="duration" min={0} label="Hours after sunset for late night" value={s.lateOffset} onChange={v => save({ lateOffset: v })} />
      {:else}<span>after</span><SituateDragValue kind="clock" label="Late night" value={s.lateMinutes} onChange={v => save({ lateMinutes: v })} />{/if}
      {#if today}<span class="muted">({clockTime(today.late)} tonight)</span>{/if}
    </div>
  </div>
  <div class="inline"><span>Entertainment access lasts</span><SituateDragValue kind="minutes" max={240} label="Entertainment access" value={s.accessMinutes} onChange={v => save({ accessMinutes: v })} /></div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
<style>
  .schedule { display:grid; gap:14px; }
  p { margin:0; font-size:13px; }
  .fields { display:grid; grid-template-columns:auto 1fr; gap:12px 24px; align-items:end; }
  .field { display:grid; gap:6px; font-size:13px; color:var(--muted); }
  .inline { display:flex; flex-wrap:wrap; align-items:center; gap:6px; font-size:13px; color:var(--muted); }
  .night { display:grid; gap:8px; padding:14px; border:1px solid var(--line); border-radius:12px; background:var(--paper-strong); }
  h4 { margin:0; font-size:14px; }
  .error { color:var(--danger); }
  @media (max-width:600px) { .fields { grid-template-columns:1fr; } }
</style>
