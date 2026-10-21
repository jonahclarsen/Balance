<script lang="ts">
  import { situate, situateNow, situatePlatform, requestQuiz, activateMode } from './situate/store'
  import { isActive } from './situate/core'
  import { browsersMissingExtension, extensionSetupOpen } from './situate/extension'
  /** Shows off modes too, so they can be turned on from here. */
  export let all = false
  $: modes = $situate.enabled ? $situate.modes.filter(m => m.platforms.includes(situatePlatform)).map(mode => ({ mode, active: isActive($situate, mode, situatePlatform, $situateNow) })).filter(m => all || m.active) : []
</script>
{#if modes.length || $browsersMissingExtension.length}
  <div class="situate-pills" aria-label="Situate modes">
    {#each modes as { mode, active } (mode.id)}
      <button class="situate-pill" class:active type="button" style:--mode={mode.color} aria-pressed={active} title={active ? `Take the quiz to turn off ${mode.name}` : `Turn on ${mode.name}`} on:click={() => active ? requestQuiz(mode.id) : activateMode(mode.id).catch(() => {})}><i aria-hidden="true"></i>{mode.name}</button>
    {/each}
    {#if $browsersMissingExtension.length}<button class="situate-pill warning" type="button" title="Websites aren’t blocked in this browser" on:click={() => extensionSetupOpen.set(true)}>! Extension</button>{/if}
  </div>
{/if}
<style>
  .situate-pills { display:flex; flex-wrap:wrap; gap:6px; padding:8px 0; }
  .situate-pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--line); border-radius:999px; padding:4px 10px; font-size:12px; font-weight:600; min-height:28px; color:var(--muted); background:transparent; }
  .situate-pill i { width:8px; height:8px; border-radius:50%; border:1.5px solid var(--mode); }
  .situate-pill.active { color:color-mix(in srgb, var(--mode) 72%, var(--ink)); border-color:color-mix(in srgb, var(--mode) 55%, transparent); background:color-mix(in srgb, var(--mode) 14%, transparent); }
  .situate-pill.active i { background:var(--mode); }
  .situate-pill.warning { color:white; background:var(--danger); border-color:var(--danger); }
</style>
