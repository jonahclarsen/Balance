<script lang="ts">
  import { onDestroy, onMount } from 'svelte'
  import peacockTalking from '../assets/peacock-talking.png'
  import type { GoalDoabilityReview } from './goals'
  import type { Id } from './types'
  import OverlayModal from './OverlayModal.svelte'

  export let reviews: GoalDoabilityReview[]
  export let onClose: () => void
  export let onSelectGoal: (goalId: Id) => void

  let mascotPanel: HTMLDivElement
  let guidancePanel: HTMLElement
  let goalsPanel: HTMLElement
  let columnShares: [number, number, number] = [0.254, 0.465, 0.281]
  let modalSize = { width: 940, height: 500 }
  let panelWidths: [number, number, number] = [0, 0, 0]
  let panelResizeObserver: ResizeObserver | null = null
  let stopColumnResize: (() => void) | null = null
  let copied = false
  let copiedResetTimer: ReturnType<typeof setTimeout> | null = null

  const PANEL_MIN_WIDTHS: [number, number, number] = [120, 240, 180]

  $: sizingSummary = `Goal review sizing: modal=${modalSize.width}x${modalSize.height}px; panels=${panelWidths[0]}/${panelWidths[1]}/${panelWidths[2]}px (peacock/guidance/goals)`

  onMount(() => {
    panelResizeObserver = new ResizeObserver(() => {
      panelWidths = [mascotPanel, guidancePanel, goalsPanel].map((panel) => (
        Math.round(panel.getBoundingClientRect().width)
      )) as [number, number, number]
    })
    panelResizeObserver.observe(mascotPanel)
    panelResizeObserver.observe(guidancePanel)
    panelResizeObserver.observe(goalsPanel)
  })

  onDestroy(() => {
    panelResizeObserver?.disconnect()
    stopColumnResize?.()
    if (copiedResetTimer) clearTimeout(copiedResetTimer)
  })

  function startColumnResize(event: PointerEvent, dividerIndex: 0 | 1) {
    event.preventDefault()
    event.stopPropagation()
    stopColumnResize?.()

    const panels = [mascotPanel, guidancePanel, goalsPanel]
    const startingWidths = panels.map((panel) => panel.getBoundingClientRect().width)
    const totalPanelWidth = startingWidths.reduce((sum, width) => sum + width, 0)
    const startX = event.clientX
    const leftIndex = dividerIndex
    const rightIndex = dividerIndex + 1
    const pairWidth = startingWidths[leftIndex] + startingWidths[rightIndex]

    const handleMove = (moveEvent: PointerEvent) => {
      const delta = moveEvent.clientX - startX
      const nextLeft = Math.min(
        pairWidth - PANEL_MIN_WIDTHS[rightIndex],
        Math.max(PANEL_MIN_WIDTHS[leftIndex], startingWidths[leftIndex] + delta),
      )
      const nextWidths = [...startingWidths]
      nextWidths[leftIndex] = nextLeft
      nextWidths[rightIndex] = pairWidth - nextLeft
      columnShares = nextWidths.map((width) => width / totalPanelWidth) as [number, number, number]
    }
    const handleUp = () => stopColumnResize?.()

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp, { once: true })
    window.addEventListener('pointercancel', handleUp, { once: true })
    stopColumnResize = () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      stopColumnResize = null
    }
  }

  async function copySizingSummary() {
    try {
      await navigator.clipboard.writeText(sizingSummary)
      copied = true
      if (copiedResetTimer) clearTimeout(copiedResetTimer)
      copiedResetTimer = setTimeout(() => (copied = false), 1800)
    } catch {
      copied = false
    }
  }
</script>

<OverlayModal
  ariaLabel="Are your goals doable?"
  z={85}
  maxWidth={940}
  initialHeight={500}
  minWidth={660}
  bodyOverflow="hidden"
  headerless
  resizable
  onResize={(size) => (modalSize = size)}
  {onClose}
>
  <div class="doability-review">
    <div
      class="review-layout"
      style={`grid-template-columns: minmax(${PANEL_MIN_WIDTHS[0]}px, ${columnShares[0]}fr) 12px minmax(${PANEL_MIN_WIDTHS[1]}px, ${columnShares[1]}fr) 12px minmax(${PANEL_MIN_WIDTHS[2]}px, ${columnShares[2]}fr)`}
    >
      <div bind:this={mascotPanel} class="mascot" aria-hidden="true">
        <img src={peacockTalking} alt="" />
      </div>

      <button
        class="column-resize-handle"
        type="button"
        aria-label="Resize peacock and guidance sections"
        title="Drag to resize these sections"
        on:pointerdown={(event) => startColumnResize(event, 0)}
      ><span></span></button>

      <section bind:this={guidancePanel} class="guidance">
        <h2>Are your goals doable?</h2>
        <p>It's easy for the goal system to get clogged. From our experience, goals work best if they are typically:</p>
        <ul>
          <li>Able to be completed in 2–3 minutes (and can optionally go longer), unless it's a longer daily habit like a morning routine list</li>
          <li>Not dependent on someone else (“reach out to a friend to game” instead of “game with a friend”)</li>
          <li>Have a mandatory escape hatch for your attention (“draw for 2–10 minutes, then close Photoshop”)</li>
        </ul>
      </section>

      <button
        class="column-resize-handle"
        type="button"
        aria-label="Resize guidance and goals sections"
        title="Drag to resize these sections"
        on:pointerdown={(event) => startColumnResize(event, 1)}
      ><span></span></button>

      <section bind:this={goalsPanel} class="goals-to-review" aria-label="Goals to review">
        <ul>
          {#each reviews as review (review.goal.id)}
            <li>
              <button
                type="button"
                aria-label={`Review ${review.goal.name}: ${review.days} ${review.days === 1 ? 'day' : 'days'} ${review.reason === 'missed-presentations' ? 'missed' : 'overdue'}`}
                on:click={() => onSelectGoal(review.goal.id)}
              >
                <span>{review.goal.name}</span>
                <strong>
                  {review.days} {review.days === 1 ? 'day' : 'days'}
                  {review.reason === 'missed-presentations' ? ' missed' : ' overdue'}
                </strong>
              </button>
            </li>
          {/each}
        </ul>
      </section>
    </div>

    <div class="sizing-readout">
      <code data-testid="goal-review-sizing">{sizingSummary}</code>
      <button type="button" on:click={copySizingSummary}>{copied ? 'Copied' : 'Copy sizes'}</button>
    </div>
  </div>
</OverlayModal>

<style>
  .doability-review {
    height: 100%;
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    gap: 10px;
    min-height: 0;
  }

  .review-layout {
    display: grid;
    align-items: stretch;
    min-width: 0;
    min-height: 0;
  }

  .mascot {
    align-self: center;
    min-width: 0;
  }

  .mascot img {
    display: block;
    width: 100%;
    height: auto;
  }

  .guidance h2 {
    margin: 0 0 10px;
    color: var(--ink);
    font-size: clamp(21px, 2.4vw, 28px);
    line-height: 1.1;
  }

  .guidance {
    min-width: 0;
    min-height: 0;
    overflow-y: auto;
  }

  .guidance p {
    margin: 0 0 12px;
    color: var(--muted);
    line-height: 1.45;
  }

  .guidance ul {
    margin: 0;
    padding-left: 20px;
    display: grid;
    gap: 9px;
    color: var(--ink);
    font-size: 13.5px;
    line-height: 1.4;
  }

  .goals-to-review {
    display: flex;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    padding: 42px 14px 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--paper);
  }

  .goals-to-review ul {
    min-height: 0;
    margin: 0;
    padding: 0;
    display: grid;
    align-content: start;
    gap: 9px;
    list-style: none;
    overflow-y: auto;
    overscroll-behavior: contain;
    scrollbar-gutter: stable;
  }

  .goals-to-review li {
    min-width: 0;
    padding-bottom: 9px;
    border-bottom: 1px solid var(--line);
  }

  .goals-to-review li:last-child {
    padding-bottom: 0;
    border-bottom: 0;
  }

  .goals-to-review button {
    width: 100%;
    padding: 2px 4px;
    display: grid;
    gap: 2px;
    border: 0;
    border-radius: 7px;
    background: transparent;
    text-align: left;
  }

  .goals-to-review button:hover,
  .goals-to-review button:focus-visible {
    background: var(--active-nav);
  }

  .goals-to-review span {
    overflow-wrap: anywhere;
    color: var(--ink);
    font-size: 13.5px;
    font-weight: 650;
  }

  .goals-to-review strong {
    color: var(--muted);
    font-size: 12px;
    font-weight: 550;
  }

  .column-resize-handle {
    position: relative;
    min-width: 12px;
    margin: 0;
    padding: 0;
    border: 0;
    background: transparent;
    cursor: ew-resize;
    touch-action: none;
  }

  .column-resize-handle span {
    position: absolute;
    inset: 18% 4px;
    border-radius: 999px;
    background: color-mix(in srgb, var(--ink) 24%, transparent);
    transition: background 120ms ease, transform 120ms ease;
  }

  .column-resize-handle:hover span,
  .column-resize-handle:focus-visible span {
    background: color-mix(in srgb, var(--ink) 58%, transparent);
    transform: scaleX(1.4);
  }

  .sizing-readout {
    min-width: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    color: var(--muted);
  }

  .sizing-readout code {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    user-select: text;
    font-size: 10.5px;
  }

  .sizing-readout button {
    flex: 0 0 auto;
    padding: 3px 7px;
    font-size: 10.5px;
  }

  @media (max-width: 760px) {
    .doability-review {
      gap: 8px;
    }

    .review-layout {
      grid-template-columns: 112px 1fr !important;
      grid-template-rows: auto minmax(120px, 1fr);
      gap: 16px;
      padding-top: 24px;
    }

    .mascot {
      align-self: start;
    }

    .goals-to-review {
      grid-column: 1 / -1;
      padding-top: 14px;
    }

    .column-resize-handle {
      display: none;
    }

    .sizing-readout {
      justify-content: flex-start;
    }
  }

  @media (max-width: 420px) {
    .review-layout {
      grid-template-columns: 96px 1fr;
      gap: 12px;
    }

    .guidance ul {
      font-size: 13px;
    }
  }
</style>
