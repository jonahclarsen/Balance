<script lang="ts">
  export let onClose: () => void
  export let title = ''
  export let ariaLabel = title || 'Dialog'
  export let z = 60
  export let maxWidth = 720
  export let bodyOverflow: 'auto' | 'hidden' = 'auto'
  export let headerless = false
  export let floatingCloseSide: 'left' | 'right' = 'right'
  export let height: number | null = null
  let backdrop: HTMLDivElement
  let mobileViewportTop = 0

  function isTopmostOverlay() {
    if (!backdrop) return false

    const overlays = Array.from(document.querySelectorAll<HTMLElement>('.overlay-backdrop'))
    const topmost = overlays.reduce<HTMLElement | null>((current, candidate) => {
      if (!current) return candidate
      const currentZ = Number.parseInt(window.getComputedStyle(current).zIndex, 10) || 0
      const candidateZ = Number.parseInt(window.getComputedStyle(candidate).zIndex, 10) || 0
      return candidateZ >= currentZ ? candidate : current
    }, null)

    return topmost === backdrop
  }

  function handleEscape(event: KeyboardEvent) {
    if (event.key === 'Escape' && isTopmostOverlay()) {
      event.stopPropagation()
      onClose()
    }
  }

</script>

<svelte:window
  on:keydown={handleEscape}
/>

<!-- Absolute layer inside .content-shell so it covers the main area + goal rhythm
     while leaving the sidebar visible. -->
<div
  bind:this={backdrop}
  class="overlay-backdrop"
  role="presentation"
  style={`z-index: ${z}; --mobile-overlay-top: ${mobileViewportTop}px; --overlay-max-width: ${maxWidth}px; --overlay-height: ${height === null ? 'auto' : `${height}px`}; --overlay-body-overflow: ${bodyOverflow}`}
  on:click|self={onClose}
  on:keydown={handleEscape}
>
  <div
    class="overlay-card"
    class:headerless
    class:fixed-height={height !== null}
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel}
  >
    {#if headerless}
      <button
        class="icon-button quiet overlay-floating-close"
        class:left={floatingCloseSide === 'left'}
        type="button"
        title="Close (Esc)"
        aria-label="Close"
        on:click={onClose}
      >✕</button>
    {:else}
      <header class="overlay-header">
        <div class="overlay-title">
          {#if title}<h3>{title}</h3>{:else}<span></span>{/if}
        </div>
        <div class="overlay-header-middle">
          <slot name="header-middle" />
        </div>
        <button class="icon-button quiet" type="button" title="Close (Esc)" aria-label="Close" on:click={onClose}>✕</button>
      </header>
    {/if}
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
    position: relative;
    display: flex;
    flex-direction: column;
    width: min(var(--overlay-max-width), 100%);
    max-height: calc(min(82vh, 100%) - var(--overlay-bottom-collapse, 0px));
    transform: translateY(calc(0px - var(--overlay-bottom-lift, 0px)));
    background: var(--paper-strong);
    border: 1px solid var(--line-strong);
    border-radius: 14px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .overlay-card.fixed-height {
    height: min(
      var(--overlay-height),
      calc(min(82vh, 100%) - var(--overlay-bottom-collapse, 0px))
    );
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
    flex: 1 1 auto;
    min-height: 0;
    padding: 18px;
    overflow-y: var(--overlay-body-overflow);
  }

  .overlay-floating-close {
    position: absolute;
    z-index: 3;
    top: 10px;
    right: 10px;
  }

  .overlay-floating-close.left {
    right: auto;
    left: 10px;
  }

  .overlay-floating-close:hover,
  .overlay-floating-close:focus-visible {
    border-color: var(--line-strong);
    background: var(--paper-strong);
    color: var(--ink);
  }

  @media (max-width: 760px) {
    .overlay-backdrop {
      position: fixed;
      inset: max(env(safe-area-inset-top), var(--mobile-overlay-top)) env(safe-area-inset-right)
        env(safe-area-inset-bottom) env(safe-area-inset-left);
      padding: 12px;
    }

    .overlay-card {
      max-height: calc(
        100dvh - max(env(safe-area-inset-top), var(--mobile-overlay-top)) - env(safe-area-inset-bottom) - 24px -
          var(--overlay-bottom-collapse, 0px)
      );
    }

    .overlay-header {
      padding: 10px 12px;
    }

    .overlay-body {
      padding: 12px;
    }

  }
</style>
