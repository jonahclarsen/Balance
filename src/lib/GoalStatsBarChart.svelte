<script lang="ts">
  type GoalStatsBarItem = {
    label: string
    value: number
    axisLabel?: string
  }

  export let items: GoalStatsBarItem[]
  export let ariaLabel: string
  export let valueLabel: (value: number) => string
  export let showCategoryLabels = false
  export let startLabel = ''
  export let endLabel = ''

  let hoveredIndex: number | null = null

  $: axisMax = Math.max(1, ...items.map((item) => item.value))
  $: ticks = [...new Set([0, Math.ceil(axisMax / 2), axisMax])]

  function valuePercent(value: number): number {
    return (value / axisMax) * 100
  }
</script>

<div class="bar-chart" role="img" aria-label={ariaLabel} style={`--bar-count: ${items.length}`}>
  <div class="chart-y-axis" aria-hidden="true">
    {#each ticks as tick}
      <span style={`--tick-position: ${valuePercent(tick)}%`}>{tick}</span>
    {/each}
  </div>
  <div class="bar-plot">
    <div class="grid-lines" aria-hidden="true">
      {#each ticks as tick}
        <i style={`--tick-position: ${valuePercent(tick)}%`}></i>
      {/each}
    </div>
    <div class="bars" aria-hidden="true">
      {#each items as item, index}
        <button
          type="button"
          tabindex="-1"
          class:active={hoveredIndex === index}
          class:tooltip-left={index >= items.length / 2}
          style={`--bar-height: ${valuePercent(item.value)}%`}
          on:mouseenter={() => (hoveredIndex = index)}
          on:mouseleave={() => (hoveredIndex = null)}
        >
          <span class="bar" class:empty={item.value === 0}></span>
          {#if hoveredIndex === index}
            <span class="chart-tooltip">
              <strong>{item.label}</strong>
              <span>{valueLabel(item.value)}</span>
            </span>
          {/if}
        </button>
      {/each}
    </div>
  </div>
  <div class="chart-x-axis" class:categories={showCategoryLabels} aria-hidden="true">
    {#if showCategoryLabels}
      {#each items as item}<span>{item.axisLabel ?? item.label}</span>{/each}
    {:else}
      <span>{startLabel}</span>
      <span>{endLabel}</span>
    {/if}
  </div>
</div>

<style>
  .bar-chart {
    display: grid;
    grid-template-columns: 30px minmax(0, 1fr);
    grid-template-rows: 122px auto;
    column-gap: 8px;
    margin-top: 10px;
  }

  .chart-y-axis {
    position: relative;
    grid-column: 1;
    grid-row: 1;
    height: 122px;
    color: var(--muted);
    font-size: 10px;
  }

  .chart-y-axis span {
    position: absolute;
    right: 0;
    bottom: var(--tick-position);
    line-height: 1;
    transform: translateY(50%);
  }

  .bar-plot {
    position: relative;
    grid-column: 2;
    grid-row: 1;
    min-width: 0;
    height: 122px;
  }

  .grid-lines,
  .bars {
    position: absolute;
    inset: 0;
  }

  .grid-lines i {
    position: absolute;
    right: 0;
    bottom: var(--tick-position);
    left: 0;
    height: 1px;
    background: var(--line);
  }

  .bars {
    display: grid;
    grid-template-columns: repeat(var(--bar-count), minmax(0, 1fr));
    align-items: end;
    z-index: 1;
  }

  .bars button {
    position: relative;
    align-self: stretch;
    min-width: 0;
    height: 100%;
    padding: 0 clamp(0px, 0.18vw, 3px);
    border: 0;
    border-radius: 0;
    background: transparent;
    box-shadow: none;
  }

  .bars button:hover,
  .bars button.active {
    border: 0;
    background: color-mix(in srgb, var(--accent) 7%, transparent);
  }

  .bar {
    position: absolute;
    right: clamp(0px, 0.18vw, 3px);
    bottom: 0;
    left: clamp(0px, 0.18vw, 3px);
    height: max(2px, var(--bar-height));
    border-radius: 3px 3px 0 0;
    background: var(--accent);
    pointer-events: none;
  }

  .bar.empty {
    background: color-mix(in srgb, var(--accent) 20%, var(--line));
  }

  .chart-tooltip {
    position: absolute;
    z-index: 5;
    top: clamp(4px, calc(100% - var(--bar-height) - 18px), calc(100% - 40px));
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

  .chart-x-axis {
    display: flex;
    grid-column: 2;
    grid-row: 2;
    justify-content: space-between;
    margin-top: 6px;
    color: var(--muted);
    font-size: 10px;
  }

  .chart-x-axis.categories {
    display: grid;
    grid-template-columns: repeat(var(--bar-count), minmax(0, 1fr));
    gap: 2px;
    text-align: center;
  }

  .chart-x-axis.categories span {
    white-space: nowrap;
  }

  @media (max-width: 520px) {
    .bar-chart {
      grid-template-columns: 24px minmax(0, 1fr);
      column-gap: 6px;
    }

    .chart-x-axis.categories {
      font-size: 9px;
    }
  }
</style>
