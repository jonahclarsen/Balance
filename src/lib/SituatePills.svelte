<script lang="ts">
  import { situate, situateNow, situatePlatform, requestQuiz } from './situate/store'
  import { isActive } from './situate/core'
  import { browsersMissingExtension, extensionSetupOpen } from './situate/extension'
  $: modes = $situate.modes.filter(mode => isActive($situate, mode, situatePlatform, $situateNow))
</script>
{#if modes.length || $browsersMissingExtension.length}
  <div class="situate-pills" aria-label="Situate modes">
    {#each modes as mode (mode.id)}
      <button class="situate-pill" type="button" style:--mode={mode.color} title={mode.reminder ? mode.description : `Take the quiz to turn off ${mode.name}`} on:click={() => requestQuiz(mode.id)}>{mode.name}</button>
    {/each}
    {#if $browsersMissingExtension.length}<button class="situate-pill warning" type="button" title="Websites aren’t blocked in this browser" on:click={() => extensionSetupOpen.set(true)}>! Extension</button>{/if}
  </div>
{/if}
<style>
  .situate-pills { display:flex; flex-wrap:wrap; gap:6px; padding:8px 0; }
  .situate-pill { display:inline-flex; align-items:center; gap:6px; border:1px solid color-mix(in srgb, var(--mode) 55%, transparent); border-radius:999px; padding:4px 10px; font-size:12px; font-weight:600; min-height:28px; color:color-mix(in srgb, var(--mode) 72%, var(--ink)); background:color-mix(in srgb, var(--mode) 14%, transparent); }
  .situate-pill.warning { color:white; background:var(--danger); border-color:var(--danger); }
</style>
