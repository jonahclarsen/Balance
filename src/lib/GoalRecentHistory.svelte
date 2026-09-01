<script lang="ts">
  import { buildGoalDayCells, shiftISODate } from './goals'
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
  $: cells = buildGoalDayCells(goal, completions, dates, currentDate)
  $: recentCompletionCount = cells.filter((cell) => cell.completed).length

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

  function cellStatus(cell: (typeof cells)[number]): string {
    if (cell.completed) return 'completed'
    if (cell.overdue) return 'overdue'
    if (cell.missed) return 'missed'
    return cell.active ? 'no completion' : 'inactive'
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
    {#each cells as cell (cell.date)}
      <li class:overdue={cell.overdue}>
        <button
          type="button"
          class="goal-recent-day"
          class:active={cell.active}
          class:completed={cell.completed}
          class:missed={cell.missed}
          class:overdue={cell.overdue}
          class:today={cell.date === currentDate}
          data-goal-date={cell.date}
          aria-label={`Open ${fullDateLabel(cell.date)} in Today view: ${cellStatus(cell)}`}
          on:click={() => onOpenDate(cell.date)}
        >
          <span class="goal-recent-day-tooltip" aria-hidden="true">{tooltipDateLabel(cell.date)}</span>
          {#if cell.completed}
            <span aria-hidden="true">✓</span>
          {:else if cell.overdue}
            <span class="goal-cell-mark overdue-mark" aria-hidden="true">×</span>
          {:else if cell.missed}
            <span class="goal-cell-mark open" aria-hidden="true"></span>
          {/if}
        </button>
      </li>
    {/each}
  </ol>
  <div class="goal-recent-history-axis" aria-hidden="true">
    <span>{dateLabel(dates[0])}</span>
    <span>Today</span>
  </div>
</section>
