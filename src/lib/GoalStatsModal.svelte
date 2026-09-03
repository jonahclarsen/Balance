<script lang="ts">
  import GoalStatsBarChart from './GoalStatsBarChart.svelte'
  import { buildGoalStats, GOAL_STATS_RANGES, type GoalStatsRangeDays } from './goalStats'
  import type { Goal, GoalCompletion } from './types'
  import OverlayModal from './OverlayModal.svelte'

  export let goals: Goal[]
  export let completions: GoalCompletion[]
  export let currentDate: string
  export let onClose: () => void

  type GoalStatsBarItem = {
    label: string
    value: number
    axisLabel?: string
  }

  const lineWidth = 1000
  const lineHeight = 164
  let rangeDays: GoalStatsRangeDays = 90
  let hoveredOverdueIndex: number | null = null

  $: stats = buildGoalStats(goals, completions, currentDate, rangeDays)
  $: overduePeak = Math.max(0, ...stats.daily.map((day) => day.overdueGoals))
  $: overdueAxisMax = Math.max(1, overduePeak)
  $: overdueTicks = [...new Set([0, Math.ceil(overdueAxisMax / 2), overdueAxisMax])]
  $: linePoints = stats.daily.map((day, index) => ({
    ...day,
    x: stats.daily.length === 1 ? lineWidth / 2 : (index / (stats.daily.length - 1)) * lineWidth,
    y: lineHeight - (day.overdueGoals / overdueAxisMax) * lineHeight,
  }))
  $: linePath = linePoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
  $: areaPath = linePoints.length > 0
    ? `${linePath} L ${linePoints.at(-1)?.x ?? 0} ${lineHeight} L ${linePoints[0]?.x ?? 0} ${lineHeight} Z`
    : ''
  $: completionItems = stats.daily.map<GoalStatsBarItem>((day) => ({
    label: formatLongDate(day.date),
    value: day.completedGoals,
  }))
  $: deadlineItems = stats.deadlineOutlook.map<GoalStatsBarItem>((category) => ({
    label: /^\d{4}-\d{2}-\d{2}$/.test(category.label) ? formatLongDate(category.label) : category.label,
    axisLabel: /^\d{4}-\d{2}-\d{2}$/.test(category.label) ? formatDate(category.label) : category.label,
    value: category.count,
  }))
  $: weekdayItems = stats.weekdayCompletions.map<GoalStatsBarItem>((category) => ({
    label: category.label,
    value: category.count,
  }))
  $: chartSummary =
    `${stats.rangeDays}-day overdue history. Started at ${stats.daily[0]?.overdueGoals ?? 0}, ` +
    `peaked at ${overduePeak}, and is now ${stats.overdueGoals}.`
  $: deadlineSummary = stats.deadlineOutlook.map((category) => `${category.label}: ${category.count}`).join('. ')
  $: weekdaySummary = stats.weekdayCompletions.map((category) => `${category.label}: ${category.count}`).join('. ')

  function parseISODate(date: string): Date {
    const [year, month, day] = date.split('-').map(Number)
    return new Date(year, month - 1, day)
  }

  function formatDate(date: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parseISODate(date))
  }

  function formatLongDate(date: string | null): string {
    if (!date) return 'Never'
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' }).format(parseISODate(date))
  }

  function completionValueLabel(value: number): string {
    return `${value} ${value === 1 ? 'goal completed' : 'goals completed'}`
  }

  function goalValueLabel(value: number): string {
    return `${value} ${value === 1 ? 'goal' : 'goals'}`
  }

  function completionCountLabel(value: number): string {
    return `${value} ${value === 1 ? 'completion' : 'completions'}`
  }
</script>

<OverlayModal title="Goal stats" ariaLabel="Goal statistics" maxWidth={1060} height={700} z={72} {onClose}>
  <div class="goal-stats">
    <div class="stats-toolbar">
      <div class="range-switcher" role="group" aria-label="Statistics date range">
        {#each GOAL_STATS_RANGES as days}
          <button type="button" class:active={rangeDays === days} aria-pressed={rangeDays === days} on:click={() => (rangeDays = days)}>{days} days</button>
        {/each}
      </div>
    </div>

    <section class="chart-card">
      <div class="section-heading">
        <div><h4>Overdue goals by day</h4><p>Average {stats.averageOverdueGoals.toFixed(1)} overdue across this period</p></div>
        <strong class:warning-text={stats.overdueGoals > 0}>{stats.overdueGoals} today</strong>
      </div>
      <div class="line-chart" role="img" aria-label={chartSummary}>
        <div class="line-y-axis" aria-hidden="true">
          {#each overdueTicks as tick}<span style={`--tick-position: ${(tick / overdueAxisMax) * 100}%`}>{tick}</span>{/each}
        </div>
        <div class="line-plot">
          <div class="line-grid" aria-hidden="true">
            {#each overdueTicks as tick}<i style={`--tick-position: ${(tick / overdueAxisMax) * 100}%`}></i>{/each}
          </div>
          <svg viewBox={`0 0 ${lineWidth} ${lineHeight}`} preserveAspectRatio="none" aria-hidden="true">
            <path class="chart-area" d={areaPath} />
            <path class="chart-line" d={linePath} />
          </svg>
          <div class="line-hit-targets" style={`--point-count: ${linePoints.length}`} aria-hidden="true">
            {#each linePoints as point, index}
              <button
                type="button"
                tabindex="-1"
                class:active={hoveredOverdueIndex === index}
                class:tooltip-left={index >= linePoints.length / 2}
                style={`--point-y: ${(point.y / lineHeight) * 100}%`}
                on:mouseenter={() => (hoveredOverdueIndex = index)}
                on:mouseleave={() => (hoveredOverdueIndex = null)}
              >
                {#if hoveredOverdueIndex === index}
                  <span class="point-marker"></span>
                  <span class="chart-tooltip">
                    <strong>{formatLongDate(point.date)}</strong>
                    <span>
                      {point.overdueGoals} {point.overdueGoals === 1 ? 'goal overdue' : 'goals overdue'}
                    </span>
                  </span>
                {/if}
              </button>
            {/each}
          </div>
        </div>
        <div class="line-x-axis" aria-hidden="true"><span>{formatDate(stats.rangeStart)}</span><span>{formatDate(stats.rangeEnd)}</span></div>
      </div>
    </section>

    <section class="chart-card">
      <div class="section-heading"><div><h4>Completion activity</h4></div></div>
      <GoalStatsBarChart
        items={completionItems}
        ariaLabel={`${stats.completionsInRange} goal completions across ${stats.completionDays} days in the selected period.`}
        valueLabel={completionValueLabel}
        startLabel={formatDate(stats.rangeStart)}
        endLabel={formatDate(stats.rangeEnd)}
      />
    </section>

    <div class="new-charts-grid">
      <section class="chart-card">
        <div class="section-heading"><div><h4>When goals are next due</h4></div></div>
        <GoalStatsBarChart
          items={deadlineItems}
          ariaLabel={`Goal deadline outlook. ${deadlineSummary}.`}
          valueLabel={goalValueLabel}
          showCategoryLabels
        />
      </section>
      <section class="chart-card">
        <div class="section-heading"><div><h4>Goal completion by day of the week</h4></div></div>
        <GoalStatsBarChart
          items={weekdayItems}
          ariaLabel={`Goal completions by weekday. ${weekdaySummary}.`}
          valueLabel={completionCountLabel}
          showCategoryLabels
        />
      </section>
    </div>
  </div>
</OverlayModal>

<style>
  .goal-stats {
    display: grid;
    gap: 14px;
  }

  .stats-toolbar,
  .section-heading,
  .section-heading > div {
    min-width: 0;
  }

  .stats-toolbar,
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .stats-toolbar {
    justify-content: flex-end;
  }

  .section-heading p {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .range-switcher {
    display: inline-flex;
    flex: 0 0 auto;
    padding: 3px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
  }

  .range-switcher button {
    padding: 5px 9px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
  }

  .range-switcher button.active {
    background: var(--active-nav);
    color: var(--ink);
  }

  .chart-card {
    padding: 13px 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
  }

  .section-heading h4 {
    margin: 0 0 2px;
    font-size: 14px;
  }

  .section-heading > strong {
    flex: 0 0 auto;
    font-size: 13px;
  }

  .warning-text {
    color: var(--danger);
  }

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

  .new-charts-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  @media (max-width: 760px) {
    .new-charts-grid {
      grid-template-columns: 1fr;
    }

    .line-chart {
      grid-template-columns: 24px minmax(0, 1fr);
      column-gap: 6px;
    }
  }

  @media (max-width: 420px) {
    .range-switcher {
      width: 100%;
    }

    .range-switcher button {
      flex: 1 1 0;
    }
  }
</style>
