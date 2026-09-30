<script lang="ts">
  import { onDestroy } from 'svelte'
  import { formatDuration, listRunTiming } from './listTiming'
  import type { PlanItem } from './types'

  export let items: PlanItem[]
  export let idealMinutes: number

  const size = 26
  const center = size / 2
  const radius = center - 1.5
  const ticks = Array.from({ length: 12 }, (_, hour) => (hour / 12) * Math.PI * 2)

  let now = Date.now()
  let timer: ReturnType<typeof setInterval> | null = null

  $: timing = listRunTiming({ items })
  $: running = timing.startedAt !== null && timing.finishedAt === null
  $: setTicking(running)
  $: idealMs = idealMinutes * 60_000
  $: elapsedMs = timing.startedAt === null ? 0 : (timing.finishedAt ?? now) - timing.startedAt
  $: fraction = idealMs > 0 ? elapsedMs / idealMs : 0
  $: over = fraction > 1
  $: percent = Math.round(fraction * 100)
  $: wedge = wedgePath(Math.min(fraction, 1))
  $: hand = xy((fraction % 1) * Math.PI * 2, radius - 2.5)
  $: label =
    timing.startedAt === null
      ? `Ideal time ${formatDuration(idealMs)} — starts when you check off the first task`
      : `${formatDuration(elapsedMs)} of ${formatDuration(idealMs)} ideal (${percent}%)`

  function setTicking(active: boolean) {
    if (active && timer === null) {
      now = Date.now()
      timer = setInterval(() => (now = Date.now()), 1000)
    } else if (!active && timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function xy(angle: number, distance: number) {
    return { x: center + Math.sin(angle) * distance, y: center - Math.cos(angle) * distance }
  }

  function point(angle: number, distance: number) {
    const { x, y } = xy(angle, distance)
    return `${x} ${y}`
  }

  // Clockwise wedge from twelve o'clock covering the elapsed share of the ideal.
  function wedgePath(share: number): string {
    if (share <= 0) return ''
    if (share >= 1) return `M ${center} ${center - radius} A ${radius} ${radius} 0 1 1 ${center - 0.001} ${center - radius} Z`
    const angle = share * Math.PI * 2
    return `M ${center} ${center} L ${point(0, radius)} A ${radius} ${radius} 0 ${share > 0.5 ? 1 : 0} 1 ${point(angle, radius)} Z`
  }

  onDestroy(() => setTicking(false))
</script>

<span
  class="list-time-clock"
  class:over
  class:idle={timing.startedAt === null}
  role="timer"
  aria-label={label}
  title={label}
>
  <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden="true" focusable="false">
    <circle class="face" cx={center} cy={center} r={radius} />
    {#if wedge}<path class="elapsed" d={wedge} />{/if}
    {#each ticks as angle, hour}
      {@const inner = xy(angle, radius - (hour % 3 === 0 ? 3 : 1.8))}
      {@const outer = xy(angle, radius)}
      <line class="tick" class:major={hour % 3 === 0} x1={inner.x} y1={inner.y} x2={outer.x} y2={outer.y} />
    {/each}
    <line class="hand" x1={center} y1={center} x2={hand.x} y2={hand.y} />
    <circle class="pin" cx={center} cy={center} r="1.2" />
  </svg>
  {#if timing.startedAt !== null}<span class="percent">{percent}%</span>{/if}
</span>

<style>
  .list-time-clock {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 5px;
    color: var(--accent);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  .list-time-clock.over {
    color: var(--danger);
  }

  .list-time-clock.idle {
    color: var(--muted);
  }

  svg {
    display: block;
    overflow: visible;
  }

  .face {
    fill: color-mix(in srgb, var(--line) 40%, transparent);
    stroke: color-mix(in srgb, var(--line-strong) 80%, transparent);
    stroke-width: 1;
  }

  .elapsed {
    fill: currentColor;
    opacity: 0.32;
  }

  .tick {
    stroke: var(--muted);
    stroke-width: 0.6;
    stroke-linecap: round;
  }

  .tick.major {
    stroke-width: 1;
  }

  .hand {
    stroke: currentColor;
    stroke-width: 1.4;
    stroke-linecap: round;
  }

  .pin {
    fill: currentColor;
  }

  .percent {
    min-width: 3ch;
  }
</style>
