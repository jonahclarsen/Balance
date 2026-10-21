<script lang="ts">
  import { onMount } from 'svelte'
  import { isTauri } from '@tauri-apps/api/core'
  import { listen } from '@tauri-apps/api/event'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { situate, situateNow, situateError, situatePlatform, startSituate, requestQuiz, activateMode, situateDeepLink, quizRequest } from './situate/store'
  import { isActive } from './situate/core'
  import SituateQuiz from './SituateQuiz.svelte'
  const close = () => { if(isTauri()) void getCurrentWindow().close() }
  // This window exists for its quiz: finishing or dismissing one closes it.
  let quizOpen = false
  $: { if(quizOpen && !$quizRequest) close(); quizOpen = !!$quizRequest }
  function onKeydown(event: KeyboardEvent) { if(event.key === 'Escape' && !$quizRequest) close() }
  onMount(() => {
    let stop: (()=>void) | undefined, unlisten: (()=>void) | undefined, mounted=true
    void startSituate().then(cleanup => {
      if(!mounted) { cleanup();return } stop=cleanup
      situateDeepLink(`balance://situate${location.search}`)
      if(isTauri()) void listen<string>('situate-widget', event => situateDeepLink(event.payload)).then(fn => { if(mounted) unlisten=fn; else fn() })
    })
    return () => { mounted=false;stop?.();unlisten?.() }
  })
</script>
<svelte:window on:keydown={onKeydown} />
<div class="drag" data-tauri-drag-region aria-hidden="true"></div>
<button class="icon-button quiet close" type="button" title="Close (Esc)" aria-label="Close" on:click={close}>✕</button>
<main><h1>Situate</h1>{#if $situateError}<p role="alert">{$situateError}</p>{/if}
{#each $situate.modes.filter(m => m.platforms.includes(situatePlatform)) as mode}
{@const active = isActive($situate,mode,situatePlatform,$situateNow)}
<button class:active style:--mode={mode.color} type="button" on:click={() => active ? requestQuiz(mode.id) : activateMode(mode.id).catch(()=>{})}><strong>{mode.name}</strong><span>{active ? 'On' : 'Off'}</span></button>
{/each}</main><SituateQuiz />
<style>.drag { position:fixed; inset:0 0 auto; height:24px; z-index:100; } .close { position:fixed; top:10px; right:10px; } main { padding:20px; max-width:500px; margin:auto; } h1 { font-size:22px; } main button { width:100%; display:flex; justify-content:space-between; margin:12px 0; padding:18px; border-radius:18px; } main button.active { border-color:var(--mode); background:color-mix(in srgb, var(--mode) 10%, transparent); } main button { border-left:5px solid var(--mode); } span { border:1px solid currentColor; border-radius:99px; padding:2px 8px; }</style>
