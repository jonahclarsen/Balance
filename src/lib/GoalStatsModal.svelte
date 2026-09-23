<script lang="ts">
  import { GOAL_STATS_URL } from './planner'
  import GoalStatsBarChart from './GoalStatsBarChart.svelte'
  import StatsLineChart from './StatsLineChart.svelte'
  import StatsChartCard from './StatsChartCard.svelte'
  import StatsRangeSwitcher from './StatsRangeSwitcher.svelte'
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
  }

  let rangeDays: GoalStatsRangeDays = 90
  let copyStatus = ''

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(GOAL_STATS_URL)
      copyStatus = 'Link copied!'
    } catch {
      copyStatus = `Copy this link: ${GOAL_STATS_URL}`
    }
  }

  $: stats = buildGoalStats(goals, completions, currentDate, rangeDays)
  $: overduePeak = Math.max(0, ...stats.daily.map((day) => day.overdueGoals))
  $: completionItems = stats.daily.map<GoalStatsBarItem>((day) => ({
    label: formatLongDate(day.date),
    value: day.completedGoals,
  }))
  $: deadlineItems = stats.deadlineOutlook.map<GoalStatsBarItem>((category) => ({
    label: category.label,
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
      <button class="copy-link" type="button" on:click={copyLink}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V4a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h4" /></svg>
        Copy stats link
      </button>
      <StatsRangeSwitcher ranges={GOAL_STATS_RANGES} bind:rangeDays />
    </div>

    {#if copyStatus}<p class="copy-status" role="status">{copyStatus}</p>{/if}

    <StatsChartCard title="Overdue goals by day" description={`Average ${stats.averageOverdueGoals.toFixed(1)} overdue across this period`}>
      <strong slot="aside" class:warning-text={stats.overdueGoals > 0}>{stats.overdueGoals} today</strong>
      <StatsLineChart
        pointLabels={stats.daily.map((day) => formatLongDate(day.date))}
        series={[{ label: 'Overdue goals', values: stats.daily.map((day) => day.overdueGoals), area: true }]}
        ariaLabel={chartSummary}
        formatValue={(value) => `${value} ${value === 1 ? 'goal overdue' : 'goals overdue'}`}
        startLabel={formatDate(stats.rangeStart)}
        endLabel={formatDate(stats.rangeEnd)}
      />
    </StatsChartCard>

    <StatsChartCard title="Completion activity">
      <GoalStatsBarChart
        items={completionItems}
        ariaLabel={`${stats.completionsInRange} goal completions across ${stats.completionDays} days in the selected period.`}
        valueLabel={completionValueLabel}
        startLabel={formatDate(stats.rangeStart)}
        endLabel={formatDate(stats.rangeEnd)}
      />
    </StatsChartCard>

    <div class="new-charts-grid">
      <StatsChartCard title="When goals are next due">
        <GoalStatsBarChart
          items={deadlineItems}
          ariaLabel={`Goal deadline outlook. ${deadlineSummary}.`}
          valueLabel={goalValueLabel}
          showCategoryLabels
        />
      </StatsChartCard>
      <StatsChartCard title="Goal completion by day of the week">
        <GoalStatsBarChart
          items={weekdayItems}
          ariaLabel={`Goal completions by weekday. ${weekdaySummary}.`}
          valueLabel={completionCountLabel}
          showCategoryLabels
        />
      </StatsChartCard>
    </div>
  </div>
</OverlayModal>

<style>
  .goal-stats {
    display: grid;
    gap: 14px;
  }

  .stats-toolbar {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .copy-link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .copy-status {
    margin: 0;
    color: var(--muted);
    overflow-wrap: anywhere;
  }

  .warning-text {
    color: var(--danger);
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
  }
</style>
