<script lang="ts">
  import { onMount } from 'svelte'
  import { listen } from '@tauri-apps/api/event'
  import { situate, situateNow, situateError, situatePlatform, startSituate, requestQuiz, activateMode, situateDeepLink } from './situate/store'
  import { isActive } from './situate/core'
  import SituateQuiz from './SituateQuiz.svelte'
  onMount(() => {
    let stop: (()=>void) | undefined, unlisten: (()=>void) | undefined, mounted=true
    void startSituate().then(cleanup => {
      if(!mounted) { cleanup();return } stop=cleanup
      const params = new URLSearchParams(location.search)
      if(params.get('mode')) requestQuiz(params.get('mode')!,params.get('target') ?? '')
      void listen<string>('situate-widget', event => situateDeepLink(event.payload)).then(fn => { if(mounted) unlisten=fn; else fn() })
    })
    return () => { mounted=false;stop?.();unlisten?.() }
  })
</script>
<main><h1>Situate</h1>{#if $situateError}<p role="alert">{$situateError}</p>{/if}
{#each $situate.modes.filter(m => m.platforms.includes(situatePlatform)) as mode}
{@const active = isActive($situate,mode,situatePlatform,$situateNow)}
<button class:active type="button" on:click={() => active ? requestQuiz(mode.id) : activateMode(mode.id).catch(()=>{})}><strong>{mode.name}</strong><span>{active ? 'On' : 'Off'}</span></button>
{/each}</main><SituateQuiz />
<style>main { padding:20px; max-width:500px; margin:auto; } h1 { font-size:22px; } button { width:100%; display:flex; justify-content:space-between; margin:12px 0; padding:18px; border-radius:18px; } button.active { border-color:var(--accent); } span { border:1px solid currentColor; border-radius:99px; padding:2px 8px; }</style>
