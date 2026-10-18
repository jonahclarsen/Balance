<script lang="ts">
  import { situate, situateNow, situatePlatform, requestQuiz } from './situate/store'
  import { isActive } from './situate/core'
  $: modes = $situate.modes.filter(m => isActive($situate, m, situatePlatform, $situateNow))
</script>
{#if modes.length}<div class="situate-pills" aria-label="Active Situate modes">{#each modes as mode}<button class="situate-pill" type="button" on:click={() => requestQuiz(mode.id)} title={`Try turning off ${mode.name}`}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3 4 6v6c0 5 8 9 8 9s8-4 8-9V6z"/><path d="m8 12 3 3 5-6"/></svg>{mode.name}</button>{/each}</div>{/if}
<style>
.situate-pills { display:flex; flex-wrap:wrap; gap:6px; padding:8px 0; } .situate-pill { display:inline-flex; align-items:center; gap:6px; border:1px solid var(--accent); border-radius:999px; padding:6px 10px; font-size:12px; min-height:32px; } svg { width:16px; height:16px; fill:none; stroke:currentColor; stroke-width:1.6; }
</style>
