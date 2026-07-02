<script lang="ts">
  export let onClose: () => void
  export let title = ''
  export let ariaLabel = title || 'Dialog'
  export let z = 60

  function handleBackdropKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.stopPropagation()
      onClose()
    }
  }
</script>

<svelte:window on:keydown={(event) => event.key === 'Escape' && onClose()} />

<!-- Absolute layer inside .content-shell so it covers the main area + goal rhythm
     while leaving the sidebar visible. -->
<div
  class="overlay-backdrop"
  role="presentation"
  style={`z-index: ${z}`}
  on:click|self={onClose}
  on:keydown={handleBackdropKeydown}
>
  <div class="overlay-card" role="dialog" aria-modal="true" aria-label={ariaLabel}>
    <header class="overlay-header">
      <div class="overlay-title">
        {#if title}<h3>{title}</h3>{:else}<span></span>{/if}
      </div>
      <div class="overlay-header-middle">
        <slot name="header-middle" />
      </div>
      <button class="icon-button quiet" type="button" title="Close (Esc)" aria-label="Close" on:click={onClose}>✕</button>
    </header>
    <div class="overlay-body">
      <slot />
    </div>
  </div>
</div>

<style>
  .overlay-backdrop {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgba(28, 26, 20, 0.4);
    backdrop-filter: blur(2px);
  }

  .overlay-card {
    display: flex;
    flex-direction: column;
    width: min(720px, 100%);
    max-height: min(82vh, 100%);
    background: var(--paper-strong);
    border: 1px solid var(--line-strong);
    border-radius: 14px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .overlay-header {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 14px 18px;
    border-bottom: 1px solid var(--line);
  }

  .overlay-title {
    min-width: 0;
    flex: 0 1 auto;
  }

  .overlay-header h3 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .overlay-header-middle {
    flex: 1 1 96px;
    min-width: 64px;
  }

  .overlay-body {
    padding: 18px;
    overflow-y: auto;
  }
</style>
