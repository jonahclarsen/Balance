<script lang="ts">
  import { formatMinutes } from './planner'
  import { buildSleepStats, SLEEP_STATS_RANGES, type SleepStatsRangeDays } from './sleepStats'
  import StatsChartCard from './StatsChartCard.svelte'
  import StatsLineChart, { type StatsLineSeries } from './StatsLineChart.svelte'
  import StatsRangeSwitcher from './StatsRangeSwitcher.svelte'
  import type { DailyPlan } from './types'

  export let plans: DailyPlan[]
  export let currentDay: string
  export let onOpenDay: (date: string) => void

  let rangeDays: SleepStatsRangeDays = 30

  $: stats = buildSleepStats(plans, currentDay, rangeDays)
  $: pointLabels = stats.daily.map((day) => formatLongDate(day.date))
  $: wakeSeries = [
    {
      label: 'Wake time',
      values: stats.daily.map((day) => day.wakeMinutes),
      formatValue: (value: number) => `Woke ${formatClock(value)}`,
      missingLabel: 'No timed tasks',
    },
  ] satisfies StatsLineSeries[]
  $: bedSeries = [
    {
      label: 'Bedtime',
      values: stats.daily.map((day) => day.bedMinutes),
      formatValue: (value: number) => `Bed ${formatClock(value)}`,
      missingLabel: 'No timed tasks',
    },
  ] satisfies StatsLineSeries[]
  $: sleepSeries = [
    {
      label: 'Sleep',
      values: stats.daily.map((day) => day.sleepMinutes),
      area: true,
      formatValue: (value: number) => `${formatDuration(value)} of sleep`,
      missingLabel: 'No sleep data',
    },
  ] satisfies StatsLineSeries[]
  $: wakeAxis = hourAxis(wakeSeries[0].values, 'floor')
  $: bedAxis = hourAxis(bedSeries[0].values, 'floor')
  $: sleepAxis = hourAxis([0, ...sleepSeries[0].values], 'zero')
  $: lastSleepMinutes = stats.daily.at(-1)?.sleepMinutes ?? null

  // Snap time axes to whole hours so tick labels read as clock times.
  function hourAxis(values: (number | null)[], mode: 'floor' | 'zero') {
    const present = values.filter((value): value is number => value !== null)
    const min = mode === 'zero' || present.length === 0 ? 0 : Math.floor(Math.min(...present) / 60) * 60
    const max = Math.max(min + 60, Math.ceil(Math.max(min, ...present) / 60) * 60)
    const mid = min + Math.round((max - min) / 120) * 60
    return { min, max, ticks: [...new Set([min, mid, max])] }
  }

  function openDayAt(index: number) {
    const date = stats.daily[index]?.date
    if (date) onOpenDay(date)
  }

  function parseISODate(date: string): Date {
    const [year, month, day] = date.split('-').map(Number)
    return new Date(year, month - 1, day)
  }

  function formatDate(date: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(parseISODate(date))
  }

  function formatLongDate(date: string): string {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short', month: 'short', day: 'numeric' }).format(parseISODate(date))
  }

  function formatDuration(minutes: number): string {
    const rounded = Math.round(minutes)
    const hours = Math.floor(rounded / 60)
    const mins = rounded % 60
    return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`
  }

  function formatClock(minutes: number): string {
    return formatMinutes(Math.round(minutes))
  }

  function averageLabel(label: string, value: number | null, format: (value: number) => string): string {
    return value === null ? '' : `${label} ${format(value)}`
  }
</script>

<section class="statistics-panel" aria-label="Statistics">
  <header class="page-header">
    <h2>Statistics</h2>
    <StatsRangeSwitcher ranges={SLEEP_STATS_RANGES} bind:rangeDays />
  </header>

  <div class="statistics-charts">
    <StatsChartCard
      title="Wake time"
      description={averageLabel('Average', stats.averageWakeMinutes, formatClock) || 'No timed tasks in this period'}
    >
      <StatsLineChart
        {pointLabels}
        onPointClick={openDayAt}
        series={wakeSeries}
        ariaLabel={`${rangeDays}-day wake time history, taken from the first timed task of each day.`}
        axisMin={wakeAxis.min}
        axisMax={wakeAxis.max}
        ticks={wakeAxis.ticks}
        formatTick={formatMinutes}
        startLabel={formatDate(stats.rangeStart)}
        endLabel={formatDate(stats.rangeEnd)}
      />
    </StatsChartCard>

    <StatsChartCard
      title="Bedtime"
      description={averageLabel('Average', stats.averageBedMinutes, formatClock) || 'No timed tasks in this period'}
    >
      <StatsLineChart
        {pointLabels}
        onPointClick={openDayAt}
        series={bedSeries}
        ariaLabel={`${rangeDays}-day bedtime history, taken from the end of the last timed task of each day.`}
        axisMin={bedAxis.min}
        axisMax={bedAxis.max}
        ticks={bedAxis.ticks}
        formatTick={formatMinutes}
        startLabel={formatDate(stats.rangeStart)}
        endLabel={formatDate(stats.rangeEnd)}
      />
    </StatsChartCard>

    <StatsChartCard
      title="Sleep duration"
      description={stats.averageSleepMinutes === null
        ? 'Needs timed tasks on consecutive days'
        : `Average ${formatDuration(stats.averageSleepMinutes)} a night across this period`}
    >
      <strong slot="aside">{lastSleepMinutes === null ? '' : `${formatDuration(lastSleepMinutes)} last night`}</strong>
      <StatsLineChart
        {pointLabels}
        onPointClick={openDayAt}
        series={sleepSeries}
        ariaLabel={`${rangeDays}-day sleep duration history, from each bedtime to the next day's wake time.`}
        axisMin={sleepAxis.min}
        axisMax={sleepAxis.max}
        ticks={sleepAxis.ticks}
        formatTick={(value) => `${value / 60}h`}
        startLabel={formatDate(stats.rangeStart)}
        endLabel={formatDate(stats.rangeEnd)}
      />
    </StatsChartCard>
  </div>
</section>

<style>
  .statistics-panel {
    min-width: 0;
  }

  .page-header h2 {
    margin: 0;
  }

  .statistics-charts {
    display: grid;
    gap: 14px;
  }
</style>
