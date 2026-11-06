<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core'
  import { getCurrentWindow } from '@tauri-apps/api/window'
  import { onMount } from 'svelte'
  import NavIcon from './NavIcon.svelte'

  export let title: string
  export let icon: 'next' | 'today' | 'templates' | 'listTemplates' | 'lists' | 'notes' | 'metrics' | 'goals' | 'projects' | 'ideas' | 'situate' | 'settings'
  export let maximized = false
  export let canMaximize = true
  export let onToggleMaximized: (event: MouseEvent) => void

  const native = isTauri()
  let inactive = false
  onMount(() => { inactive = !document.hasFocus() })
</script>

<svelte:window on:focus={() => (inactive = false)} on:blur={() => (inactive = true)} />

<div class="window-caption" class:inactive data-tauri-drag-region={native ? '' : undefined}>
  <NavIcon name={icon} />
  <span class="window-caption-title" data-tauri-drag-region={native ? '' : undefined}>{title}</span>
  <div class="window-caption-buttons">
    <button class="caption-button caption-min" type="button" title="Minimize" aria-label="Minimize" disabled={!native} on:click={() => void getCurrentWindow().minimize()}></button>
    <button class="caption-button caption-max" class:restore={maximized} type="button" title={maximized ? 'Restore' : 'Maximize'} aria-label={maximized ? 'Restore' : 'Maximize'} disabled={!canMaximize} on:click={onToggleMaximized}></button>
    <button class="caption-button caption-close" type="button" title="Close" aria-label="Close" disabled={!native} on:click={() => void getCurrentWindow().close()}></button>
  </div>
</div>
