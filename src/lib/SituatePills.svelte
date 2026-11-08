<script lang="ts">
  import { situate, situateNow, situatePlatform, requestQuiz } from './situate/store'
  import { isActive, nextChange } from './situate/core'
  import { clockTime } from './situate/ui'
  import { browsersMissingExtension, extensionSetupOpen } from './situate/extension'
  $: pills = $situate.modes.flatMap(mode => {
    const on = isActive($situate, mode, situatePlatform, $situateNow)
    const change = nextChange($situate, mode, situatePlatform, $situateNow)
    return on || change ? [{ mode, on, change }] : []
  })
</script>
{#if pills.length || $browsersMissingExtension.length}
  <div class="situate-pills" aria-label="Situate modes">
    {#each pills as { mode, on, change } (mode.id)}
      {#if on || mode.reminder}
        <button class="situate-pill" class:upcoming={!on} type="button" style:--mode={mode.color} title={mode.reminder ? mode.description : `Take the quiz to turn off ${mode.name}`} on:click={() => requestQuiz(mode.id)}>{mode.name}{#if change}{' '}<span class="when">{on ? 'to' : 'at'} {clockTime(change)}</span>{/if}</button>
      {:else}
        <span class="situate-pill upcoming" style:--mode={mode.color} title={mode.description}>{mode.name}{#if change}{' '}<span class="when">at {clockTime(change)}</span>{/if}</span>
      {/if}
    {/each}
    {#if $browsersMissingExtension.length}<button class="situate-pill warning" type="button" title="Websites aren’t blocked in this browser" on:click={() => extensionSetupOpen.set(true)}>! Extension</button>{/if}
  </div>
{/if}
<style>
  .situate-pills { display:flex; flex-wrap:wrap; gap:6px; padding:8px 0; }
  .situate-pill { display:inline-flex; align-items:center; gap:5px; border:1px solid color-mix(in srgb, var(--mode) 55%, transparent); border-radius:999px; padding:4px 10px; font-size:12px; font-weight:600; min-height:28px; color:color-mix(in srgb, var(--mode) 72%, var(--ink)); background:color-mix(in srgb, var(--mode) 14%, transparent); }
  .situate-pill.upcoming { border-style:dashed; border-color:color-mix(in srgb, var(--mode) 35%, transparent); color:var(--muted); background:transparent; }
  .when { font-size:10px; font-weight:500; line-height:1; opacity:.68; }
  .situate-pill.warning { color:white; background:var(--danger); border-color:var(--danger); }
</style>
