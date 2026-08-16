<script lang="ts">
  // A lightweight inline-SVG graph. Both numeric and boolean questions use a
  // calendar-time x-axis so gaps between entries remain visible.
  export let type: 'number' | 'boolean'
  export let points: { date: string; value: number }[] = []

  type DatedPoint = { date: string; value: number; timestamp: number }
  type DateTick = { x: number; label: string }
  type TickInterval = { unit: 'day' | 'week' | 'month' | 'year'; count: number; approximateDays: number }

  const WIDTH = 520
  const HEIGHT = 150
  const LEFT_PAD = 38
  const RIGHT_PAD = 12
  const TOP_PAD = 14
  const AXIS_Y = 112
  const DAY_MS = 86_400_000
  const MAX_DATE_TICKS = 5
  const MIN_TICK_SPACING = 68
  const TICK_INTERVALS: TickInterval[] = [
    { unit: 'day', count: 1, approximateDays: 1 },
    { unit: 'day', count: 2, approximateDays: 2 },
    { unit: 'week', count: 1, approximateDays: 7 },
    { unit: 'week', count: 2, approximateDays: 14 },
    { unit: 'month', count: 1, approximateDays: 30.4 },
    { unit: 'month', count: 2, approximateDays: 60.8 },
    { unit: 'month', count: 3, approximateDays: 91.3 },
    { unit: 'month', count: 6, approximateDays: 182.6 },
    { unit: 'year', count: 1, approximateDays: 365.25 },
    { unit: 'year', count: 2, approximateDays: 730.5 },
    { unit: 'year', count: 5, approximateDays: 1826.25 },
  ]

  $: datedPoints = points
    .map((point) => ({ ...point, timestamp: parseDate(point.date) }))
    .filter((point): point is DatedPoint => Number.isFinite(point.timestamp))
    .sort((a, b) => a.timestamp - b.timestamp)
  $: minTime = datedPoints[0]?.timestamp ?? 0
  $: maxTime = datedPoints[datedPoints.length - 1]?.timestamp ?? minTime
  $: dateTicks = computeDateTicks(minTime, maxTime)
  $: numericGeometry = computeNumeric(datedPoints)
  $: linePath = numericGeometry.coords.map((coord, index) => `${index === 0 ? 'M' : 'L'} ${coord.x} ${coord.y}`).join(' ')

  function parseDate(date: string): number {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!match) return Number.NaN
    return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))
  }

  function xForTime(timestamp: number, start = minTime, end = maxTime): number {
    if (start === end) return (LEFT_PAD + WIDTH - RIGHT_PAD) / 2
    return LEFT_PAD + ((timestamp - start) / (end - start)) * (WIDTH - LEFT_PAD - RIGHT_PAD)
  }

  function computeNumeric(values: DatedPoint[]) {
    if (values.length === 0) return { coords: [] as (DatedPoint & { x: number; y: number })[], min: 0, max: 0 }
    const ys = values.map((point) => point.value)
    const min = Math.min(...ys)
    const max = Math.max(...ys)
    const span = max - min || 1
    const coords = values.map((point) => ({
      ...point,
      x: xForTime(point.timestamp, values[0].timestamp, values[values.length - 1].timestamp),
      y: AXIS_Y - ((point.value - min) / span) * (AXIS_Y - TOP_PAD),
    }))
    return { coords, min, max }
  }

  function computeDateTicks(start: number, end: number): DateTick[] {
    if (!datedPoints.length) return []
    if (start === end) return [makeTick(start, start, end)]

    const spanDays = (end - start) / DAY_MS
    const interval = TICK_INTERVALS.find((candidate) => spanDays / candidate.approximateDays <= MAX_DATE_TICKS - 1)
      ?? TICK_INTERVALS[TICK_INTERVALS.length - 1]
    const timestamps = [start, ...calendarBoundaries(start, end, interval), end]
    const unique = [...new Set(timestamps)].sort((a, b) => a - b)
    const kept = [start]
    for (const timestamp of unique.slice(1, -1)) {
      const x = xForTime(timestamp, start, end)
      const previousX = xForTime(kept[kept.length - 1], start, end)
      if (x - previousX >= MIN_TICK_SPACING && xForTime(end, start, end) - x >= MIN_TICK_SPACING) kept.push(timestamp)
    }
    kept.push(end)
    return kept.map((timestamp) => makeTick(timestamp, start, end))
  }

  function calendarBoundaries(start: number, end: number, interval: TickInterval): number[] {
    const result: number[] = []
    const cursor = new Date(start)

    if (interval.unit === 'day') {
      const stepDays = interval.count
      const dayNumber = Math.floor(start / DAY_MS)
      let nextDay = dayNumber - (dayNumber % stepDays) + stepDays
      while (nextDay * DAY_MS < end) {
        result.push(nextDay * DAY_MS)
        nextDay += stepDays
      }
      return result
    }

    if (interval.unit === 'week') {
      const epochMonday = Math.floor(Date.UTC(1970, 0, 5) / DAY_MS)
      const dayNumber = Math.floor(start / DAY_MS)
      const weekNumber = Math.floor((dayNumber - epochMonday) / 7)
      let nextWeek = weekNumber - (weekNumber % interval.count) + interval.count
      while ((epochMonday + nextWeek * 7) * DAY_MS < end) {
        result.push((epochMonday + nextWeek * 7) * DAY_MS)
        nextWeek += interval.count
      }
      return result
    }

    if (interval.unit === 'month') {
      cursor.setUTCDate(1)
      cursor.setUTCHours(0, 0, 0, 0)
      let monthNumber = cursor.getUTCFullYear() * 12 + cursor.getUTCMonth()
      monthNumber = monthNumber - (monthNumber % interval.count) + interval.count
      cursor.setUTCFullYear(Math.floor(monthNumber / 12), monthNumber % 12, 1)
      while (cursor.getTime() < end) {
        result.push(cursor.getTime())
        cursor.setUTCMonth(cursor.getUTCMonth() + interval.count)
      }
      return result
    }

    cursor.setUTCMonth(0, 1)
    cursor.setUTCHours(0, 0, 0, 0)
    let year = cursor.getUTCFullYear()
    year = year - (year % interval.count) + interval.count
    cursor.setUTCFullYear(year)
    while (cursor.getTime() < end) {
      result.push(cursor.getTime())
      cursor.setUTCFullYear(cursor.getUTCFullYear() + interval.count)
    }
    return result
  }

  function makeTick(timestamp: number, start: number, end: number): DateTick {
    const date = new Date(timestamp)
    const crossesYears = new Date(start).getUTCFullYear() !== new Date(end).getUTCFullYear()
    const spansMostOfYear = end - start >= 300 * DAY_MS
    const label = date.toLocaleDateString('en-US', {
      timeZone: 'UTC',
      month: 'short',
      day: spansMostOfYear ? undefined : 'numeric',
      year: crossesYears || spansMostOfYear ? '2-digit' : undefined,
    })
    return { x: xForTime(timestamp, start, end), label }
  }
</script>

{#if points.length === 0}
  <p class="empty">No data yet.</p>
{:else if datedPoints.length === 0}
  <p class="empty">No dated data yet.</p>
{:else}
  <svg class="metric-graph" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={type === 'number' ? 'Numeric history over time' : 'Yes/no history over time'}>
    {#if type === 'number'}
      <line x1={LEFT_PAD} y1={AXIS_Y} x2={WIDTH - RIGHT_PAD} y2={AXIS_Y} class="axis" />
      <path d={linePath} class="line" fill="none" />
      {#each numericGeometry.coords as coord}
        <circle cx={coord.x} cy={coord.y} r="3" class="dot">
          <title>{coord.date}: {coord.value}</title>
        </circle>
      {/each}
      <text x={LEFT_PAD - 5} y={TOP_PAD + 4} text-anchor="end" class="label">{numericGeometry.max}</text>
      <text x={LEFT_PAD - 5} y={AXIS_Y + 4} text-anchor="end" class="label">{numericGeometry.min}</text>
    {:else}
      <line x1={LEFT_PAD} y1="35" x2={WIDTH - RIGHT_PAD} y2="35" class="guide" />
      <line x1={LEFT_PAD} y1="85" x2={WIDTH - RIGHT_PAD} y2="85" class="guide" />
      <line x1={LEFT_PAD} y1={AXIS_Y} x2={WIDTH - RIGHT_PAD} y2={AXIS_Y} class="axis" />
      <text x={LEFT_PAD - 5} y="39" text-anchor="end" class="label">Yes</text>
      <text x={LEFT_PAD - 5} y="89" text-anchor="end" class="label">No</text>
      {#each datedPoints as point}
        <circle cx={xForTime(point.timestamp)} cy={point.value === 1 ? 35 : 85} r="4" class="dot">
          <title>{point.date}: {point.value === 1 ? 'yes' : 'no'}</title>
        </circle>
      {/each}
    {/if}

    {#each dateTicks as tick, index}
      <line x1={tick.x} y1={AXIS_Y} x2={tick.x} y2={AXIS_Y + 4} class="axis" />
      <text
        x={tick.x}
        y={AXIS_Y + 18}
        text-anchor={dateTicks.length === 1 ? 'middle' : index === 0 ? 'start' : index === dateTicks.length - 1 ? 'end' : 'middle'}
        class="date-label"
      >{tick.label}</text>
    {/each}
  </svg>
{/if}

<style>
  .metric-graph {
    width: 100%;
    max-width: 520px;
    height: auto;
  }

  .axis,
  .guide {
    stroke: var(--line);
    stroke-width: 1;
  }

  .guide {
    stroke-dasharray: 2 3;
  }

  .line {
    stroke: var(--accent);
    stroke-width: 2;
  }

  .dot {
    fill: var(--accent-strong);
  }

  .label,
  .date-label {
    fill: var(--muted);
    font-size: 11px;
  }
</style>
