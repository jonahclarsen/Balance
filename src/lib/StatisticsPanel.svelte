<script lang="ts">
  import { formatMinutes } from './planner'
  import { buildSleepStats, SLEEP_STATS_RANGES, type SleepStatsRangeDays } from './sleepStats'
  import StatsChartCard from './StatsChartCard.svelte'
  import StatsLineChart, { type StatsLineSeries } from './StatsLineChart.svelte'
  import StatsRangeSwitcher from './StatsRangeSwitcher.svelte'
  import type { DailyPlan } from './types'

  export let plans: DailyPlan[]
  export let currentDay: string

  let rangeDays: SleepStatsRangeDays = 30

  $: stats = buildSleepStats(plans, currentDay, rangeDays)
  $: pointLabels = stats.daily.map((day) => formatLongDate(day.date))
  // Each day plots the bedtime that started its night below its wake time,
  // so the shaded band between them is the sleep that ended that morning.
  $: sleepSeries = [
    {
      label: 'Wake time',
      values: stats.daily.map((day) => day.wakeMinutes),
      formatValue: (value: number) => `Woke ${formatClock(value)}`,
      missingLabel: 'No timed tasks',
    },
    {
      label: 'Bedtime',
      values: stats.daily.map((day) => day.priorBedMinutes),
      tone: 'secondary',
      formatValue: (value: number) => `Bed ${formatClock(value)} the night before`,
      missingLabel: '',
    },
    {
      label: 'Sleep',
      values: stats.daily.map((day) => day.sleepMinutes),
      hidden: true,
      formatValue: (value: number) => `Slept ${formatDuration(value)}`,
      missingLabel: '',
    },
  ] satisfies StatsLineSeries[]
  $: timeAxis = hourAxis([...sleepSeries[0].values, ...sleepSeries[1].values])
  $: lastSleepMinutes = stats.daily.at(-1)?.sleepMinutes ?? null

  // Snap time axes to whole hours so tick labels read as clock times.
  function hourAxis(values: (number | null)[]) {
    const present = values.filter((value): value is number => value !== null)
    const min = present.length === 0 ? 0 : Math.floor(Math.min(...present) / 60) * 60
    const max = Math.max(min + 60, Math.ceil(Math.max(min, ...present) / 60) * 60)
    const mid = min + Math.round((max - min) / 120) * 60
    return { min, max, ticks: [...new Set([min, mid, max])] }
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
      title="Sleep"
      description={[
        averageLabel('Average bed', stats.averageBedMinutes, formatClock),
        averageLabel('wake', stats.averageWakeMinutes, formatClock),
        averageLabel('sleep', stats.averageSleepMinutes, formatDuration),
      ].filter(Boolean).join(' · ') || 'No timed tasks in this period'}
    >
      <div slot="aside" class="chart-legend" aria-hidden="true">
        <span><i class="secondary"></i>Bed</span>
        <span><i></i>Wake</span>
        <span><i class="band"></i>Sleep</span>
        {#if lastSleepMinutes !== null}<strong>{formatDuration(lastSleepMinutes)} last night</strong>{/if}
      </div>
      <StatsLineChart
        {pointLabels}
        series={sleepSeries}
        band={{ from: 1, to: 0 }}
        ariaLabel={`${rangeDays}-day sleep history: bedtime, wake time, and sleep duration, taken from the last and first timed tasks of each day.`}
        axisMin={timeAxis.min}
        axisMax={timeAxis.max}
        ticks={timeAxis.ticks}
        formatTick={formatMinutes}
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

  .chart-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    flex: 0 0 auto;
    gap: 12px;
    color: var(--muted);
    font-size: 12px;
  }

  .chart-legend span {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }

  .chart-legend i {
    width: 14px;
    height: 0;
    border-top: 2.5px solid var(--accent-strong);
  }

  .chart-legend i.secondary {
    border-top: 2px dashed var(--muted);
  }

  .chart-legend i.band {
    height: 10px;
    border: 0;
    border-radius: 2px;
    background: color-mix(in srgb, var(--accent) 14%, transparent);
  }

  .chart-legend strong {
    color: var(--ink);
    font-size: 13px;
  }
</style>
