<script lang="ts">
  import { buildGoalStats, GOAL_STATS_RANGES, type GoalStatsRangeDays } from './goalStats'
  import type { Goal, GoalCompletion } from './types'
  import OverlayModal from './OverlayModal.svelte'

  export let goals: Goal[]
  export let completions: GoalCompletion[]
  export let currentDate: string
  export let onClose: () => void

  const chartWidth = 760
  const chartHeight = 210
  const plotTop = 14
  const plotBottom = 176
  let rangeDays: GoalStatsRangeDays = 90

  $: stats = buildGoalStats(goals, completions, currentDate, rangeDays)
  $: chartMax = Math.max(1, ...stats.daily.map((day) => day.overdueGoals))
  $: linePoints = stats.daily.map((day, index) => ({
    ...day,
    x: stats.daily.length === 1 ? chartWidth / 2 : (index / (stats.daily.length - 1)) * chartWidth,
    y: plotBottom - (day.overdueGoals / chartMax) * (plotBottom - plotTop),
  }))
  $: linePath = linePoints.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x} ${point.y}`).join(' ')
  $: areaPath = linePoints.length > 0
    ? `${linePath} L ${linePoints.at(-1)?.x ?? 0} ${plotBottom} L ${linePoints[0]?.x ?? 0} ${plotBottom} Z`
    : ''
  $: completionMax = Math.max(1, ...stats.daily.map((day) => day.completedGoals))
  $: attentionPreview = stats.needsAttention.slice(0, 6)
  $: completedPreview = stats.mostCompleted.slice(0, 6)
  $: chartSummary = stats.daily.length === 0
    ? 'No overdue history'
    : `${stats.rangeDays}-day overdue history. Started at ${stats.daily[0].overdueGoals}, peaked at ${chartMax}, and is now ${stats.overdueGoals}.`

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

  function overdueLabel(daysUntilLapse: number | null): string {
    const days = Math.abs(daysUntilLapse ?? 0)
    return `${days} ${days === 1 ? 'day' : 'days'} overdue`
  }

  function cadencePercent(count: number): number {
    return stats.activeGoals === 0 ? 0 : (count / stats.activeGoals) * 100
  }
</script>

<OverlayModal title="Goal stats" ariaLabel="Goal statistics" maxWidth={1060} height={700} z={72} {onClose}>
  <div class="goal-stats">
    <div class="stats-toolbar">
      <p>Health and progress across all goals.</p>
      <div class="range-switcher" role="group" aria-label="Statistics date range">
        {#each GOAL_STATS_RANGES as days}
          <button
            type="button"
            class:active={rangeDays === days}
            aria-pressed={rangeDays === days}
            on:click={() => (rangeDays = days)}
          >{days} days</button>
        {/each}
      </div>
    </div>

    <section class="summary-grid" aria-label="Goal overview">
      <article>
        <span>Active</span>
        <strong>{stats.activeGoals}</strong>
        <small>{stats.archivedGoals} archived</small>
      </article>
      <article class:warning={stats.overdueGoals > 0}>
        <span>Overdue now</span>
        <strong>{stats.overdueGoals}</strong>
        <small>{stats.onTrackGoals} on track</small>
      </article>
      <article>
        <span>Completions</span>
        <strong>{stats.completionsInRange}</strong>
        <small>past {stats.rangeDays} days</small>
      </article>
      <article>
        <span>Days with progress</span>
        <strong>{stats.completionDays}</strong>
        <small>of {stats.rangeDays} days</small>
      </article>
      <article>
        <span>Goals progressed</span>
        <strong>{stats.completedGoalsInRange}</strong>
        <small>of {goals.length} total</small>
      </article>
    </section>

    <section class="chart-card">
      <div class="section-heading">
        <div>
          <h4>Overdue goals by day</h4>
          <p>Average {stats.averageOverdueGoals.toFixed(1)} overdue across this period</p>
        </div>
        <strong class:warning-text={stats.overdueGoals > 0}>{stats.overdueGoals} today</strong>
      </div>
      <div class="overdue-chart">
        <svg viewBox={`0 0 ${chartWidth} ${chartHeight}`} role="img" aria-label={chartSummary} preserveAspectRatio="none">
          <line class="chart-grid-line" x1="0" y1={plotTop} x2={chartWidth} y2={plotTop} />
          <line class="chart-grid-line" x1="0" y1={(plotTop + plotBottom) / 2} x2={chartWidth} y2={(plotTop + plotBottom) / 2} />
          <line class="chart-grid-line" x1="0" y1={plotBottom} x2={chartWidth} y2={plotBottom} />
          <path class="chart-area" d={areaPath} />
          <path class="chart-line" d={linePath} />
          {#each linePoints as point}
            <circle class="chart-point" cx={point.x} cy={point.y} r="5">
              <title>{formatLongDate(point.date)}: {point.overdueGoals} overdue</title>
            </circle>
          {/each}
        </svg>
        <div class="chart-axis" aria-hidden="true">
          <span>{formatDate(stats.rangeStart)}</span>
          <span>{formatDate(stats.rangeEnd)}</span>
        </div>
      </div>
    </section>

    <section class="chart-card completion-card">
      <div class="section-heading">
        <div>
          <h4>Completion activity</h4>
          <p>Each bar is the number of goals completed that day</p>
        </div>
      </div>
      <div
        class="completion-bars"
        role="img"
        aria-label={`${stats.completionsInRange} goal completions across ${stats.completionDays} days in the selected period.`}
      >
        {#each stats.daily as day}
          <span
            class:has-completions={day.completedGoals > 0}
            title={`${formatLongDate(day.date)}: ${day.completedGoals} completed`}
            style={`--completion-height: ${Math.max(day.completedGoals > 0 ? 8 : 2, (day.completedGoals / completionMax) * 100)}%`}
          ><i></i></span>
        {/each}
      </div>
      <div class="chart-axis" aria-hidden="true">
        <span>{formatDate(stats.rangeStart)}</span>
        <span>{formatDate(stats.rangeEnd)}</span>
      </div>
    </section>

    <div class="details-grid">
      <section class="detail-card">
        <div class="section-heading">
          <div>
            <h4>Needs attention</h4>
            <p>Active goals currently overdue</p>
          </div>
        </div>
        {#if attentionPreview.length > 0}
          <ol class="stat-list attention-list">
            {#each attentionPreview as row}
              <li>
                <span class="goal-dot" style={`--goal-hue: ${row.goal.hue}`}></span>
                <div><strong>{row.goal.name}</strong><small>Last completed {formatLongDate(row.latestCompletionDate)}</small></div>
                <b>{overdueLabel(row.daysUntilLapse)}</b>
              </li>
            {/each}
          </ol>
          {#if stats.needsAttention.length > attentionPreview.length}
            <p class="more-note">+{stats.needsAttention.length - attentionPreview.length} more overdue</p>
          {/if}
        {:else}
          <div class="detail-empty"><strong>Everything is on track</strong><span>No active goals are overdue today.</span></div>
        {/if}
      </section>

      <section class="detail-card">
        <div class="section-heading">
          <div>
            <h4>Most completions</h4>
            <p>During the selected {stats.rangeDays}-day period</p>
          </div>
        </div>
        {#if completedPreview.length > 0}
          <ol class="stat-list">
            {#each completedPreview as row}
              <li>
                <span class="goal-dot" style={`--goal-hue: ${row.goal.hue}`}></span>
                <div><strong>{row.goal.name}</strong><small>Last completed {formatLongDate(row.latestCompletionDate)}</small></div>
                <b>{row.completionsInRange}</b>
              </li>
            {/each}
          </ol>
        {:else}
          <div class="detail-empty"><strong>No completions yet</strong><span>Completed goals will show up here.</span></div>
        {/if}
      </section>
    </div>

    <section class="cadence-card">
      <div class="section-heading">
        <div>
          <h4>Active goal cadence</h4>
          <p>How often your current goals come due</p>
        </div>
      </div>
      <div class="cadence-grid">
        <div><span><strong>Daily</strong><b>{stats.cadence.daily}</b></span><i><u style={`width: ${cadencePercent(stats.cadence.daily)}%`}></u></i></div>
        <div><span><strong>Every 2–7 days</strong><b>{stats.cadence.weekly}</b></span><i><u style={`width: ${cadencePercent(stats.cadence.weekly)}%`}></u></i></div>
        <div><span><strong>Every 8+ days</strong><b>{stats.cadence.longer}</b></span><i><u style={`width: ${cadencePercent(stats.cadence.longer)}%`}></u></i></div>
      </div>
    </section>
  </div>
</OverlayModal>

<style>
  .goal-stats {
    display: grid;
    gap: 14px;
  }

  .stats-toolbar,
  .section-heading,
  .section-heading > div,
  .stat-list li,
  .stat-list li > div,
  .cadence-grid > div,
  .cadence-grid span {
    min-width: 0;
  }

  .stats-toolbar,
  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .stats-toolbar p,
  .section-heading p,
  .more-note {
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

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));
    gap: 8px;
  }

  .summary-grid article,
  .chart-card,
  .detail-card,
  .cadence-card {
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
  }

  .summary-grid article {
    display: grid;
    gap: 2px;
    padding: 11px 12px;
  }

  .summary-grid article.warning {
    border-color: color-mix(in srgb, var(--danger) 38%, var(--line));
  }

  .summary-grid span {
    color: var(--muted);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: 0.03em;
    text-transform: uppercase;
  }

  .summary-grid strong {
    color: var(--ink);
    font-size: 25px;
    line-height: 1.1;
  }

  .summary-grid small {
    color: var(--muted);
    font-size: 11px;
  }

  .chart-card,
  .detail-card,
  .cadence-card {
    padding: 13px 14px;
  }

  .section-heading h4 {
    margin: 0 0 2px;
    font-size: 14px;
  }

  .section-heading > strong {
    flex: 0 0 auto;
    font-size: 13px;
  }

  .warning-text,
  .attention-list b {
    color: var(--danger);
  }

  .overdue-chart {
    margin-top: 8px;
  }

  .overdue-chart svg {
    display: block;
    width: 100%;
    height: 190px;
    overflow: visible;
  }

  .chart-grid-line {
    stroke: var(--line);
    stroke-width: 1;
    vector-effect: non-scaling-stroke;
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

  .chart-point {
    fill: transparent;
    stroke: transparent;
  }

  .chart-point:last-of-type {
    fill: var(--accent-strong);
    stroke: var(--paper-strong);
    stroke-width: 2;
    vector-effect: non-scaling-stroke;
  }

  .chart-axis {
    display: flex;
    justify-content: space-between;
    margin-top: 3px;
    color: var(--muted);
    font-size: 10px;
  }

  .completion-bars {
    display: flex;
    align-items: end;
    gap: clamp(1px, 0.25vw, 3px);
    height: 72px;
    margin-top: 12px;
    border-bottom: 1px solid var(--line);
  }

  .completion-bars > span {
    display: flex;
    align-items: end;
    flex: 1 1 0;
    min-width: 1px;
    height: 100%;
  }

  .completion-bars i {
    display: block;
    width: 100%;
    height: var(--completion-height);
    border-radius: 2px 2px 0 0;
    background: color-mix(in srgb, var(--accent) 22%, var(--line));
  }

  .completion-bars .has-completions i {
    background: var(--accent);
  }

  .details-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 14px;
  }

  .stat-list {
    display: grid;
    gap: 0;
    margin: 8px 0 0;
    padding: 0;
    list-style: none;
  }

  .stat-list li {
    display: grid;
    grid-template-columns: 8px minmax(0, 1fr) auto;
    align-items: center;
    gap: 8px;
    padding: 7px 0;
    border-top: 1px solid var(--line);
  }

  .stat-list li > div {
    display: grid;
  }

  .stat-list strong {
    overflow: hidden;
    color: var(--ink);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .stat-list small {
    color: var(--muted);
    font-size: 10px;
  }

  .stat-list b {
    font-size: 11px;
    white-space: nowrap;
  }

  .goal-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: hsl(var(--goal-hue) 58% 48%);
  }

  .more-note {
    padding-top: 4px;
    text-align: right;
  }

  .detail-empty {
    display: grid;
    place-content: center;
    min-height: 96px;
    color: var(--muted);
    text-align: center;
  }

  .detail-empty strong {
    color: var(--ink);
    font-size: 13px;
  }

  .detail-empty span {
    font-size: 11px;
  }

  .cadence-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 16px;
    margin-top: 10px;
  }

  .cadence-grid > div {
    display: grid;
    gap: 5px;
  }

  .cadence-grid span {
    display: flex;
    justify-content: space-between;
    gap: 8px;
    font-size: 11px;
  }

  .cadence-grid i {
    height: 5px;
    overflow: hidden;
    border-radius: 99px;
    background: var(--line);
  }

  .cadence-grid u {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--accent);
    text-decoration: none;
  }

  @media (max-width: 760px) {
    .stats-toolbar {
      align-items: stretch;
      flex-direction: column;
    }

    .range-switcher {
      align-self: start;
    }

    .summary-grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }

    .summary-grid article:last-child {
      grid-column: 1 / -1;
    }

    .overdue-chart svg {
      height: 145px;
    }

    .details-grid,
    .cadence-grid {
      grid-template-columns: 1fr;
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
