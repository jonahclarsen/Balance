<script module lang="ts">
  // On phones the page itself scrolls behind the fixed backdrop. While any
  // overlay is open the document stays put, so a swipe that overshoots the
  // card cannot scroll the day underneath it.
  let openOverlays = 0
  const SCROLL_LOCK_CLASS = 'overlay-scroll-lock'
  const PHONE_QUERY = '(max-width: 760px)'
</script>

<script lang="ts">
  import { onMount, onDestroy } from 'svelte'
  import { dismissOnBackdropClick } from './backdropDismiss'
  import { fitVisualViewport } from './fitVisualViewport'

  export let active = true
  // Without onClose the dialog can't be dismissed (no close button, Escape or
  // backdrop press), for prompts that must be answered.
  export let onClose: (() => void) | null = null
  export let title = ''
  export let linkURL: string | undefined = undefined
  export let eyebrow = ''
  export let ariaLabel = ''
  export let role: 'dialog' | 'alertdialog' = 'dialog'
  export let z = 60
  export let maxWidth = 720
  export let bodyOverflow: 'auto' | 'hidden' = 'auto'
  // Lays the body out as a column so its content can fill the card and scroll
  // its own regions.
  export let fill = false
  export let headerless = false
  export let floatingCloseSide: 'left' | 'right' = 'right'
  export let height: number | null = null
  // 'content' covers the page area beside the sidebar; 'viewport' covers the
  // whole window for prompts that block the entire app.
  export let cover: 'content' | 'viewport' = 'content'
  // Turn off when the opener already routes Escape through its own key handling.
  export let closeOnEscape = true
  export let closeDisabled = false
  export let closeTitle = 'Close (Esc)'
  export let backdropStyle = ''
  let className = ''
  export { className as class }
  let backdrop: HTMLDivElement

  $: label = ariaLabel || title || 'Dialog'
  $: dismiss = () => {
    if (onClose && !closeDisabled) onClose()
  }

  function isTopmostOverlay() {
    if (!active || !backdrop) return false

    const overlays = Array.from(document.querySelectorAll<HTMLElement>('.overlay-backdrop:not([hidden])'))
    const topmost = overlays.reduce<HTMLElement | null>((current, candidate) => {
      if (!current) return candidate
      const currentZ = Number.parseInt(window.getComputedStyle(current).zIndex, 10) || 0
      const candidateZ = Number.parseInt(window.getComputedStyle(candidate).zIndex, 10) || 0
      return candidateZ >= currentZ ? candidate : current
    }, null)

    return topmost === backdrop
  }

  let mounted = false
  let scrollLocked = false
  function updateScrollLock(visible: boolean) {
    if (visible === scrollLocked) return
    openOverlays += visible ? 1 : -1
    scrollLocked = visible
    document.documentElement.classList.toggle(SCROLL_LOCK_CLASS, openOverlays > 0)
  }
  $: if (mounted) updateScrollLock(active)
  onMount(() => { mounted = true })
  onDestroy(() => { if (mounted) updateScrollLock(false) })

  // Phone keyboards shrink only the visual viewport, so pin the backdrop to it
  // and keep focused inputs above the keyboard.
  function fitPhoneViewport(node: HTMLElement) {
    const phone = window.matchMedia(PHONE_QUERY)
    let fitted: ReturnType<typeof fitVisualViewport> | null = null
    const sync = () => {
      if (phone.matches && !fitted) {
        fitted = fitVisualViewport(node)
      } else if (!phone.matches && fitted) {
        fitted.destroy?.()
        fitted = null
        node.style.top = ''
        node.style.height = ''
      }
    }
    sync()
    phone.addEventListener('change', sync)
    return {
      destroy() {
        phone.removeEventListener('change', sync)
        fitted?.destroy?.()
      },
    }
  }

  function handleEscape(event: KeyboardEvent) {
    if (closeOnEscape && event.key === 'Escape' && isTopmostOverlay()) {
      event.stopPropagation()
      dismiss()
    }
  }

</script>

<svelte:window
  on:keydown={handleEscape}
/>

<!-- By default an absolute layer inside .content-shell so it covers the main
     area + goal rhythm while leaving the sidebar visible. -->
<div
  bind:this={backdrop}
  class="overlay-backdrop"
  class:viewport={cover === 'viewport'}
  hidden={!active}
  inert={!active}
  role="presentation"
  style={`z-index: ${z}; --overlay-max-width: ${maxWidth}px; --overlay-height: ${height === null ? 'auto' : `${height}px`}; --overlay-body-overflow: ${bodyOverflow}; ${backdropStyle}`}
  use:dismissOnBackdropClick={dismiss}
  use:fitPhoneViewport
  on:keydown={handleEscape}
>
  <div
    class="overlay-card {className}"
    data-balance-link={linkURL}
    class:headerless
    class:fixed-height={height !== null}
    {role}
    aria-modal="true"
    aria-label={label}
  >
    {#if headerless}
      {#if onClose}
        <button
          class="icon-button quiet overlay-floating-close"
          class:left={floatingCloseSide === 'left'}
          type="button"
          title={closeTitle}
          aria-label="Close"
          disabled={closeDisabled}
          on:click={dismiss}
        >✕</button>
      {/if}
    {:else}
      <header class="overlay-header">
        <div class="overlay-title" class:beside-middle={$$slots['header-middle']}>
          {#if eyebrow}<p class="eyebrow overlay-eyebrow">{eyebrow}</p>{/if}
          {#if title}<h3>{title}</h3>{:else}<span></span>{/if}
        </div>
        {#if $$slots['header-middle']}
          <div class="overlay-header-middle">
            <slot name="header-middle" />
          </div>
        {/if}
        {#if onClose}
          <button
            class="icon-button quiet"
            type="button"
            title={closeTitle}
            aria-label="Close"
            disabled={closeDisabled}
            on:click={dismiss}
          >✕</button>
        {/if}
      </header>
    {/if}
    <div class="overlay-body" class:fill>
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
    background: var(--modal-backdrop);
    backdrop-filter: blur(2px);
  }

  .overlay-backdrop[hidden] { display: none; }

  .overlay-backdrop.viewport {
    position: fixed;
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
    border-radius: var(--radius-modal);
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
    flex: 1 1 auto;
  }

  .overlay-title.beside-middle {
    flex: 0 1 auto;
  }

  .overlay-header h3 {
    margin: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .overlay-title:not(.beside-middle) h3 {
    white-space: normal;
    overflow-wrap: anywhere;
  }

  .overlay-eyebrow {
    margin: 0 0 2px;
  }

  .overlay-header-middle {
    flex: 1 1 96px;
    min-width: 64px;
  }

  .overlay-body {
    /* Pinned task parents meet the body's top edge. */
    --tree-sticky-base: -18px;
    flex: 1 1 auto;
    min-height: 0;
    padding: 18px;
    overflow-y: var(--overlay-body-overflow);
  }

  .overlay-body.fill {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }

  .overlay-body.fill > :global(*) {
    flex: 1 1 auto;
    min-height: 0;
  }

  .overlay-floating-close {
    position: absolute;
    z-index: 3;
    top: 10px;
    right: 10px;
    opacity: 0.72;
    transition:
      opacity 160ms ease,
      border-color 160ms ease,
      background-color 160ms ease,
      color 160ms ease;
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
    opacity: 1;
  }

  @media (max-width: 760px) {
    :global(html.overlay-scroll-lock),
    :global(html.overlay-scroll-lock body) {
      overflow: hidden;
    }

    .overlay-backdrop {
      position: fixed;
      inset: 0;
      /* Touches on the dimmed area belong to the overlay, not the page. */
      touch-action: none;
      /* Cover the safe areas with blur while keeping the card inside them. */
      padding: calc(12px + env(safe-area-inset-top)) calc(12px + env(safe-area-inset-right))
        calc(12px + env(safe-area-inset-bottom)) calc(12px + env(safe-area-inset-left));
    }

    /* The backdrop tracks the visible viewport, so the card fits inside it
       above an open keyboard. */
    .overlay-card {
      max-height: calc(100% - var(--overlay-bottom-collapse, 0px));
    }

    .overlay-card.fixed-height {
      height: min(var(--overlay-height), calc(100% - var(--overlay-bottom-collapse, 0px)));
    }

    .overlay-header {
      padding: 10px 12px;
    }

    .overlay-body {
      --tree-sticky-base: -12px;
      padding: 12px;
      overscroll-behavior: contain;
    }

  }
</style>
