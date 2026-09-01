<script lang="ts">
  import { onDestroy, onMount } from 'svelte'

  export let onClose: () => void
  export let title = ''
  export let ariaLabel = title || 'Dialog'
  export let z = 60
  export let maxWidth = 720
  export let bodyOverflow: 'auto' | 'hidden' = 'auto'
  export let headerless = false
  export let resizable = false
  export let initialHeight = 500
  export let minWidth = 640
  export let minHeight = 360
  export let onResize: (size: { width: number; height: number }) => void = () => {}
  let backdrop: HTMLDivElement
  let card: HTMLDivElement
  let mobileViewportTop = 0
  let cardWidth = maxWidth
  let cardHeight = initialHeight
  let resizeObserver: ResizeObserver | null = null
  let stopActiveResize: (() => void) | null = null

  const clamp = (value: number, minimum: number, maximum: number) => Math.min(maximum, Math.max(minimum, value))

  onMount(() => {
    if (!resizable) return
    resizeObserver = new ResizeObserver(([entry]) => {
      if (!entry) return
      const rect = card.getBoundingClientRect()
      onResize({ width: Math.round(rect.width), height: Math.round(rect.height) })
    })
    resizeObserver.observe(card)
  })

  onDestroy(() => {
    resizeObserver?.disconnect()
    stopActiveResize?.()
  })

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

  function startResize(event: PointerEvent, axis: 'horizontal' | 'vertical' | 'both') {
    if (!resizable || !card || !backdrop) return

    event.preventDefault()
    event.stopPropagation()
    stopActiveResize?.()

    const cardRect = card.getBoundingClientRect()
    const backdropStyle = window.getComputedStyle(backdrop)
    const availableWidth = backdrop.clientWidth
      - Number.parseFloat(backdropStyle.paddingLeft)
      - Number.parseFloat(backdropStyle.paddingRight)
    const availableHeight = backdrop.clientHeight
      - Number.parseFloat(backdropStyle.paddingTop)
      - Number.parseFloat(backdropStyle.paddingBottom)
    const startX = event.clientX
    const startY = event.clientY

    const handleMove = (moveEvent: PointerEvent) => {
      if (axis !== 'vertical') {
        cardWidth = clamp(cardRect.width + (moveEvent.clientX - startX) * 2, Math.min(minWidth, availableWidth), availableWidth)
      }
      if (axis !== 'horizontal') {
        cardHeight = clamp(cardRect.height + (moveEvent.clientY - startY) * 2, Math.min(minHeight, availableHeight), availableHeight)
      }
    }
    const handleUp = () => stopActiveResize?.()

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
    window.addEventListener('pointercancel', handleUp, { once: true })
    stopActiveResize = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      stopActiveResize = null
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
  style={`z-index: ${z}; --mobile-overlay-top: ${mobileViewportTop}px; --overlay-max-width: ${maxWidth}px; --overlay-body-overflow: ${bodyOverflow}`}
  on:click|self={onClose}
  on:keydown={handleEscape}
>
  <div
    bind:this={card}
    class="overlay-card"
    class:headerless
    class:resizable
    role="dialog"
    aria-modal="true"
    aria-label={ariaLabel}
    style={`--overlay-card-width: ${cardWidth}px; --overlay-card-height: ${cardHeight}px; --overlay-min-width: ${minWidth}px; --overlay-min-height: ${minHeight}px`}
  >
    {#if headerless}
      <button class="icon-button quiet overlay-floating-close" type="button" title="Close (Esc)" aria-label="Close" on:click={onClose}>✕</button>
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
    {#if resizable}
      <button
        class="modal-resize-handle modal-resize-handle-horizontal"
        type="button"
        aria-label="Resize modal width"
        title="Drag to resize modal width"
        on:pointerdown={(event) => startResize(event, 'horizontal')}
      ></button>
      <button
        class="modal-resize-handle modal-resize-handle-vertical"
        type="button"
        aria-label="Resize modal height"
        title="Drag to resize modal height"
        on:pointerdown={(event) => startResize(event, 'vertical')}
      ></button>
      <button
        class="modal-resize-handle modal-resize-handle-both"
        type="button"
        aria-label="Resize modal width and height"
        title="Drag to resize modal width and height"
        on:pointerdown={(event) => startResize(event, 'both')}
      ></button>
    {/if}
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
    width: min(var(--overlay-card-width), 100%);
    max-height: calc(min(82vh, 100%) - var(--overlay-bottom-collapse, 0px));
    transform: translateY(calc(0px - var(--overlay-bottom-lift, 0px)));
    background: var(--paper-strong);
    border: 1px solid var(--line-strong);
    border-radius: 14px;
    box-shadow: var(--shadow);
    overflow: hidden;
  }

  .overlay-card.resizable {
    height: min(
      var(--overlay-card-height),
      calc(min(82vh, 100%) - var(--overlay-bottom-collapse, 0px))
    );
    min-width: min(var(--overlay-min-width), 100%);
    min-height: min(var(--overlay-min-height), 100%);
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

  .modal-resize-handle {
    position: absolute;
    z-index: 4;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
  }

  .modal-resize-handle::after {
    content: '';
    position: absolute;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ink) 28%, transparent);
    transition: background 120ms ease;
  }

  .modal-resize-handle:hover::after,
  .modal-resize-handle:focus-visible::after {
    background: color-mix(in srgb, var(--ink) 58%, transparent);
  }

  .modal-resize-handle-horizontal {
    top: 25%;
    right: 0;
    width: 10px;
    height: 50%;
    cursor: ew-resize;
  }

  .modal-resize-handle-horizontal::after {
    inset: 30% 3px;
  }

  .modal-resize-handle-vertical {
    right: 25%;
    bottom: 0;
    width: 50%;
    height: 10px;
    cursor: ns-resize;
  }

  .modal-resize-handle-vertical::after {
    inset: 3px 30%;
  }

  .modal-resize-handle-both {
    right: 0;
    bottom: 0;
    width: 18px;
    height: 18px;
    cursor: nwse-resize;
  }

  .modal-resize-handle-both::after {
    right: 3px;
    bottom: 3px;
    width: 9px;
    height: 9px;
    border: solid color-mix(in srgb, var(--ink) 42%, transparent);
    border-width: 0 2px 2px 0;
    border-radius: 0;
    background: transparent;
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

    .overlay-card.resizable {
      min-width: 0;
      min-height: min(360px, 100%);
    }

    .overlay-header {
      padding: 10px 12px;
    }

    .overlay-body {
      padding: 12px;
    }

    .modal-resize-handle {
      display: none;
    }
  }
</style>
