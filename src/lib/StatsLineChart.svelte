<script context="module" lang="ts">
  export type StatsLineSeries = {
    label: string
    values: (number | null)[]
    // Secondary series draw as a dashed, muted line so two lines on one axis
    // stay distinguishable in every theme without adding theme tokens.
    tone?: 'primary' | 'secondary'
    // Fills under the line's contiguous runs, down to the axis minimum.
    area?: boolean
    formatValue?: (value: number) => string
    missingLabel?: string
  }
</script>

<script lang="ts">
  export let pointLabels: string[]
  export let series: StatsLineSeries[]
  export let ariaLabel: string
  export let startLabel = ''
  export let endLabel = ''
  export let formatTick: (value: number) => string = String
  export let formatValue: (value: number) => string = String
  // Defaults to 0…peak, matching the count-based charts.
  export let axisMin = 0
  export let axisMax: number | null = null
  export let ticks: number[] | null = null

  const lineWidth = 1000
  const lineHeight = 164
  let hoveredIndex: number | null = null

  $: resolvedAxisMax = axisMax ?? Math.max(
    axisMin + 1,
    ...series.flatMap((line) => line.values.filter((value): value is number => value !== null)),
  )
  $: axisSpan = Math.max(1, resolvedAxisMax - axisMin)
  $: resolvedTicks = ticks ?? [...new Set([axisMin, Math.ceil((axisMin + resolvedAxisMax) / 2), resolvedAxisMax])]
  $: plottedSeries = series.map((line) => {
    const points = line.values.map((value, index) => value === null ? null : {
      x: pointLabels.length === 1 ? lineWidth / 2 : (index / (pointLabels.length - 1)) * lineWidth,
      y: lineHeight - ((value - axisMin) / axisSpan) * lineHeight,
    })
    const runs: { x: number; y: number }[][] = []
    let run: { x: number; y: number }[] = []
    for (const point of points) {
      if (point) run.push(point)
      else if (run.length > 0) {
        runs.push(run)
        run = []
      }
    }
    if (run.length > 0) runs.push(run)
    const runPath = (points: { x: number; y: number }[]) =>
      points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
    return {
      ...line,
      points,
      linePath: runs.map(runPath).join(' '),
      // A lone point has no line segment, so draw it as a dot instead.
      dots: runs.filter((points) => points.length === 1).map((points) => points[0]),
      areaPath: line.area
        ? runs.map((points) =>
          `${runPath(points)} L ${points.at(-1)?.x ?? 0} ${lineHeight} L ${points[0]?.x ?? 0} ${lineHeight} Z`,
        ).join(' ')
        : '',
    }
  })

  function tickPercent(tick: number): number {
    return ((tick - axisMin) / axisSpan) * 100
  }
</script>

<div class="line-chart" role="img" aria-label={ariaLabel}>
  <div class="line-y-axis" aria-hidden="true">
    {#each resolvedTicks as tick}<span style={`--tick-position: ${tickPercent(tick)}%`}>{formatTick(tick)}</span>{/each}
  </div>
  <div class="line-plot">
    <div class="line-grid" aria-hidden="true">
      {#each resolvedTicks as tick}<i style={`--tick-position: ${tickPercent(tick)}%`}></i>{/each}
    </div>
    <svg viewBox={`0 0 ${lineWidth} ${lineHeight}`} preserveAspectRatio="none" aria-hidden="true">
      {#each plottedSeries as line}
        {#if line.areaPath}<path class="chart-area" d={line.areaPath} />{/if}
      {/each}
      {#each plottedSeries as line}
        <path class="chart-line" class:secondary={line.tone === 'secondary'} d={line.linePath} />
      {/each}
    </svg>
    <div class="lone-points" aria-hidden="true">
      {#each plottedSeries as line}
        {#each line.dots as dot}
          <i
            class:secondary={line.tone === 'secondary'}
            style={`--point-x: ${(dot.x / lineWidth) * 100}%; --point-y: ${(dot.y / lineHeight) * 100}%`}
          ></i>
        {/each}
      {/each}
    </div>
    <div class="line-hit-targets" style={`--point-count: ${pointLabels.length}`} aria-hidden="true">
      {#each pointLabels as pointLabel, index}
        {@const hoveredPoints = plottedSeries.filter((line) => line.points[index])}
        <button
          type="button"
          tabindex="-1"
          class:active={hoveredIndex === index}
          class:tooltip-left={index >= pointLabels.length / 2}
          style={`--point-y: ${((hoveredPoints[0]?.points[index]?.y ?? lineHeight / 2) / lineHeight) * 100}%`}
          on:mouseenter={() => (hoveredIndex = index)}
          on:mouseleave={() => (hoveredIndex = null)}
        >
          {#if hoveredIndex === index}
            {#each hoveredPoints as line}
              <span
                class="point-marker"
                class:secondary={line.tone === 'secondary'}
                style={`--point-y: ${((line.points[index]?.y ?? 0) / lineHeight) * 100}%`}
              ></span>
            {/each}
            <span class="chart-tooltip">
              <strong>{pointLabel}</strong>
              {#each plottedSeries as line}
                {@const value = line.values[index]}
                {@const valueLabel = value === null ? line.missingLabel ?? 'No data' : (line.formatValue ?? formatValue)(value)}
                {#if valueLabel}<span>{valueLabel}</span>{/if}
              {/each}
            </span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
  <div class="line-x-axis" aria-hidden="true"><span>{startLabel}</span><span>{endLabel}</span></div>
</div>

<style>
  .line-chart {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    grid-template-rows: 164px auto;
    column-gap: 8px;
    margin-top: 10px;
  }

  .line-y-axis {
    position: relative;
    grid-column: 1;
    grid-row: 1;
    height: 164px;
    color: var(--muted);
    font-size: 10px;
  }

  .line-y-axis span {
    position: absolute;
    right: 0;
    bottom: var(--tick-position);
    line-height: 1;
    white-space: nowrap;
    transform: translateY(50%);
  }

  .line-plot {
    position: relative;
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
    height: 164px;
  }

  .line-grid,
  .line-plot svg,
  .lone-points,
  .line-hit-targets {
    position: absolute;
    inset: 0;
  }

  .line-grid i {
    position: absolute;
    right: 0;
    bottom: var(--tick-position);
    left: 0;
    height: 1px;
    background: var(--line);
  }

  .line-plot svg {
    z-index: 1;
    width: 100%;
    height: 100%;
    overflow: visible;
  }

  .chart-area {
    fill: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .chart-line {
    fill: none;
    stroke: var(--accent-strong);
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2.5;
    vector-effect: non-scaling-stroke;
  }

  .chart-line.secondary {
    stroke: var(--muted);
    stroke-dasharray: 5 4;
  }

  .lone-points {
    z-index: 1;
    pointer-events: none;
  }

  .lone-points i {
    position: absolute;
    top: var(--point-y);
    left: var(--point-x);
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--accent-strong);
    transform: translate(-50%, -50%);
  }

  .lone-points i.secondary {
    background: var(--muted);
  }

  .line-hit-targets {
    z-index: 2;
    display: grid;
    grid-template-columns: repeat(var(--point-count), minmax(0, 1fr));
  }

  .line-hit-targets button {
    position: relative;
    min-width: 0;
    height: 100%;
    padding: 0;
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .line-hit-targets button:hover,
  .line-hit-targets button.active {
    border: 0;
    background: color-mix(in srgb, var(--accent) 7%, transparent);
  }

  .point-marker {
    position: absolute;
    top: var(--point-y);
    left: 50%;
    width: 8px;
    height: 8px;
    border: 2px solid var(--paper-strong);
    border-radius: 50%;
    background: var(--accent-strong);
    box-shadow: 0 0 0 1px var(--accent-strong);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  .point-marker.secondary {
    background: var(--muted);
    box-shadow: 0 0 0 1px var(--muted);
  }

  .chart-tooltip {
    position: absolute;
    z-index: 5;
    top: clamp(4px, calc(var(--point-y) - 18px), calc(100% - 40px));
    left: calc(50% + 8px);
    display: grid;
    width: max-content;
    max-width: 150px;
    padding: 6px 8px;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--paper-strong);
    box-shadow: var(--shadow);
    color: var(--ink);
    font-size: 10px;
    line-height: 1.25;
    text-align: left;
    pointer-events: none;
  }

  .tooltip-left .chart-tooltip {
    right: calc(50% + 8px);
    left: auto;
  }

  .chart-tooltip strong {
    font-size: 10px;
  }

  .chart-tooltip span {
    color: var(--muted);
  }

  .line-x-axis {
    display: flex;
    grid-column: 2;
    grid-row: 2;
    justify-content: space-between;
    margin-top: 6px;
    color: var(--muted);
    font-size: 10px;
  }

  @media (max-width: 760px) {
    .line-chart {
      grid-template-columns: 24px minmax(0, 1fr);
      column-gap: 6px;
    }
  }
</style>
