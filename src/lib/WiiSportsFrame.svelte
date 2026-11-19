<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core'

  // The Wii Sports menu frame: a white bar above and below the blue field, the
  // grey caption tab naming the screen and the wordmark where the game's logo
  // sits. Decorative; the page keeps its own headings.
  export let title: string

  const drag = isTauri() ? '' : undefined
</script>

<div class="wii-frame wii-frame-top" aria-hidden="true" data-tauri-drag-region={drag}>
  <span class="wii-caption" data-tauri-drag-region={drag}><span>{title}</span></span>
  <span class="wii-wordmark" data-tauri-drag-region={drag}>Balance</span>
</div>
<div class="wii-frame wii-frame-bottom" aria-hidden="true"></div>
