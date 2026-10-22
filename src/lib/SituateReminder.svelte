<script lang="ts">
  import OverlayModal from './OverlayModal.svelte'
  import { situate, reminderRequest } from './situate/store'
  $: mode = $situate.modes.find(m => m.id === $reminderRequest)
</script>
{#if mode}
  <OverlayModal title={mode.name} onClose={() => reminderRequest.set(null)} maxWidth={480} cover="viewport" z={150}>
    <p class="reminder" style:--mode={mode.color}>{mode.description || 'No description yet.'}</p>
  </OverlayModal>
{/if}
<style>.reminder { margin:0; padding:14px 2px 22px 14px; border-left:4px solid var(--mode); font-size:1.25rem; line-height:1.5; white-space:pre-wrap; }</style>
