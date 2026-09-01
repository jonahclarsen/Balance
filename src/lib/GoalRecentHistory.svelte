<script lang="ts">
  import { isGoalActiveOnDate, shiftISODate } from './goals'
  import type { Goal, GoalCompletion } from './types'

  export let goal: Goal
  export let completions: GoalCompletion[]
  export let currentDate: string
  export let onOpenDate: (date: string) => void

  const RECENT_DAY_COUNT = 14

  $: dates = Array.from(
    { length: RECENT_DAY_COUNT },
    (_, index) => shiftISODate(currentDate, index - (RECENT_DAY_COUNT - 1)),
  )
  $: completionDates = new Set(completions.map((completion) => completion.date))
  $: recentCompletionCount = dates.filter((date) => completionDates.has(date)).length

  function dateLabel(date: string): string {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(
      new Date(`${date}T12:00:00`),
    )
  }

  function fullDateLabel(date: string): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    }).format(new Date(`${date}T12:00:00`))
  }

  function tooltipDateLabel(date: string): string {
    return new Intl.DateTimeFormat(undefined, {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
    }).format(new Date(`${date}T12:00:00`))
  }

  function completionSummary(count: number): string {
    if (count === 0) return 'No completions'
    return `${count} completion${count === 1 ? '' : 's'}`
  }
</script>

<section
  class="goal-recent-history"
  aria-label={`Recent 14-day history for ${goal.name}: ${completionSummary(recentCompletionCount)}`}
>
  <div class="goal-recent-history-header">
    <span>Recent 14 days</span>
    <small>{completionSummary(recentCompletionCount)}</small>
  </div>
  <ol class="goal-recent-days">
    {#each dates as date (date)}
      {@const active = isGoalActiveOnDate(goal, date)}
      {@const completed = completionDates.has(date)}
      <li>
        <button
          type="button"
          class="goal-recent-day"
          class:active
          class:completed
          class:today={date === currentDate}
          data-goal-date={date}
          aria-label={`Open ${fullDateLabel(date)} in Today view: ${completed ? 'completed' : active ? 'no completion' : 'inactive'}`}
          on:click={() => onOpenDate(date)}
        >
          <span class="goal-recent-day-tooltip" aria-hidden="true">{tooltipDateLabel(date)}</span>
          {#if completed}<span aria-hidden="true">✓</span>{/if}
        </button>
      </li>
    {/each}
  </ol>
  <div class="goal-recent-history-axis" aria-hidden="true">
    <span>{dateLabel(dates[0])}</span>
    <span>Today</span>
  </div>
</section>
