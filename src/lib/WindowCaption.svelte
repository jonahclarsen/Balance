<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core'
  import { onMount } from 'svelte'
  import NavIcon from './NavIcon.svelte'
  import { closeWindow, minimizeWindow, toggleFullscreen } from './nativeWindow'

  // XP and Vista put Minimize, Maximize and Close on the right. The 1984
  // Macintosh had a close box on the left; the zoom box on the right arrived
  // with the Mac Plus, and Balance needs it for full screen.
  export let variant: 'windows' | 'mac'
  export let title: string
  export let icon: 'next' | 'today' | 'templates' | 'listTemplates' | 'lists' | 'notes' | 'metrics' | 'goals' | 'projects' | 'ideas' | 'situate' | 'settings' | null = null
  export let fullscreen = false

  const native = isTauri()
  let inactive = false
  onMount(() => { inactive = !document.hasFocus() })
</script>

<svelte:window on:focus={() => (inactive = false)} on:blur={() => (inactive = true)} />

<div class="window-caption window-caption-{variant}" class:inactive data-tauri-drag-region={native ? '' : undefined}>
  {#if variant === 'mac'}
    <button class="caption-button caption-close" type="button" title="Close" aria-label="Close" disabled={!native} on:click={closeWindow}></button>
    <span class="window-caption-title" data-tauri-drag-region={native ? '' : undefined}>{title}</span>
    <button class="caption-button caption-max" class:restore={fullscreen} type="button" title={fullscreen ? 'Exit Full Screen' : 'Full Screen'} aria-label={fullscreen ? 'Exit Full Screen' : 'Full Screen'} disabled={!native} on:click={() => void toggleFullscreen()}></button>
  {:else}
    {#if icon}<NavIcon name={icon} />{/if}
    <span class="window-caption-title" data-tauri-drag-region={native ? '' : undefined}>{title}</span>
    <div class="window-caption-buttons">
      <button class="caption-button caption-min" type="button" title="Minimize" aria-label="Minimize" disabled={!native} on:click={() => void minimizeWindow()}></button>
      <button class="caption-button caption-max" class:restore={fullscreen} type="button" title={fullscreen ? 'Restore' : 'Maximize'} aria-label={fullscreen ? 'Restore' : 'Maximize'} disabled={!native} on:click={() => void toggleFullscreen()}></button>
      <button class="caption-button caption-close" type="button" title="Close" aria-label="Close" disabled={!native} on:click={closeWindow}></button>
    </div>
  {/if}
</div>
