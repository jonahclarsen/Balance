<script lang="ts">
  // A lightweight inline-SVG graph. Numeric questions get a line+dot chart over
  // time; boolean questions get a y/n strip (a missing day reads as "n").
  export let type: 'number' | 'boolean'
  export let points: { date: string; value: number }[] = []

  const WIDTH = 520
  const HEIGHT = 120
  const PAD = 28

  $: sorted = [...points].sort((a, b) => a.date.localeCompare(b.date))

  $: numericGeometry = computeNumeric(sorted)

  function computeNumeric(values: { date: string; value: number }[]) {
    if (values.length === 0) return { coords: [] as { x: number; y: number; date: string; value: number }[], min: 0, max: 0 }
    const ys = values.map((point) => point.value)
    const min = Math.min(...ys)
    const max = Math.max(...ys)
    const span = max - min || 1
    const stepX = values.length > 1 ? (WIDTH - PAD * 2) / (values.length - 1) : 0
    const coords = values.map((point, index) => ({
      x: PAD + stepX * index,
      y: HEIGHT - PAD - ((point.value - min) / span) * (HEIGHT - PAD * 2),
      date: point.date,
      value: point.value,
    }))
    return { coords, min, max }
  }

  $: linePath = numericGeometry.coords.map((coord, index) => `${index === 0 ? 'M' : 'L'} ${coord.x} ${coord.y}`).join(' ')
</script>

{#if points.length === 0}
  <p class="empty">No data yet.</p>
{:else if type === 'number'}
  <svg class="metric-graph" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label="Numeric history">
    <line x1={PAD} y1={HEIGHT - PAD} x2={WIDTH - PAD} y2={HEIGHT - PAD} class="axis" />
    <path d={linePath} class="line" fill="none" />
    {#each numericGeometry.coords as coord}
      <circle cx={coord.x} cy={coord.y} r="3" class="dot">
        <title>{coord.date}: {coord.value}</title>
      </circle>
    {/each}
    <text x={PAD} y={14} class="label">{numericGeometry.max}</text>
    <text x={PAD} y={HEIGHT - PAD + 16} class="label">{numericGeometry.min}</text>
  </svg>
{:else}
  <div class="bool-strip" role="img" aria-label="Yes/no history">
    {#each sorted as point}
      <span class="bool-cell" class:yes={point.value === 1} title={`${point.date}: ${point.value === 1 ? 'yes' : 'no'}`}></span>
    {/each}
  </div>
{/if}

<style>
  .metric-graph {
    width: 100%;
    max-width: 520px;
    height: auto;
  }

  .axis {
    stroke: var(--line);
    stroke-width: 1;
  }

  .line {
    stroke: var(--accent);
    stroke-width: 2;
  }

  .dot {
    fill: var(--accent-strong);
  }

  .label {
    fill: var(--muted);
    font-size: 11px;
  }

  .bool-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    max-width: 520px;
  }

  .bool-cell {
    width: 14px;
    height: 14px;
    border-radius: 3px;
    background: color-mix(in srgb, var(--muted) 22%, transparent);
  }

  .bool-cell.yes {
    background: var(--accent);
  }
</style>
