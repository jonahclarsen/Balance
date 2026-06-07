<script lang="ts">
  import { onMount } from 'svelte'
  import {
    buildGoalDayCells,
    GOAL_HISTORY_DEFAULT_DAYS,
    GOAL_HISTORY_MAX_DAYS,
    goalWasActiveInRange,
    shiftISODate,
    visibleGoalDates,
  } from './goals'
  import { todayISO } from './planner'
  import type { Goal, GoalCompletion } from './types'

  const HISTORY_DAYS_KEY = 'balance.goalHistoryDays'

  export let goals: Goal[]
  export let completions: GoalCompletion[]
  export let onOpenGoals: () => void
  export let onSelectDate: (date: string) => void

  let historyDays = GOAL_HISTORY_DEFAULT_DAYS

  $: pastDates = visibleGoalDates(historyDays)
  $: futureDayCount = Math.max(0, ...goals.map((goal) => goal.cadenceDays - 1))
  $: futureDates = Array.from({ length: futureDayCount }, (_, index) => shiftISODate(todayISO(), index + 1))
  $: dates = [...pastDates, ...futureDates]
  $: visibleGoals = goals.filter((goal) => goalWasActiveInRange(goal, dates))

  onMount(() => {
    const stored = Number(localStorage.getItem(HISTORY_DAYS_KEY))
    if (Number.isFinite(stored) && stored >= 1) historyDays = Math.min(GOAL_HISTORY_MAX_DAYS, Math.round(stored))
  })

  function updateHistoryDays(value: number) {
    historyDays = Math.max(1, Math.min(GOAL_HISTORY_MAX_DAYS, Math.round(value) || GOAL_HISTORY_DEFAULT_DAYS))
    localStorage.setItem(HISTORY_DAYS_KEY, String(historyDays))
  }

  function dayLabel(date: string) {
    return new Intl.DateTimeFormat(undefined, { weekday: 'short' }).format(new Date(`${date}T12:00:00`)).slice(0, 1)
  }

  function dateLabel(date: string) {
    return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(new Date(`${date}T12:00:00`))
  }
</script>

<section class="goal-history-panel" aria-label="Goal history">
  <header class="goal-history-toolbar">
    <div>
      <strong>Goal rhythm</strong>
      <span>{historyDays} past days{futureDayCount > 0 ? ` + ${futureDayCount} future` : ''}</span>
    </div>
    <label class="goal-days-control">
      <span>Days</span>
      <input
        aria-label="Days of goal history"
        type="number"
        min="1"
        max={GOAL_HISTORY_MAX_DAYS}
        value={historyDays}
        on:change={(event) => updateHistoryDays(Number(event.currentTarget.value))}
      />
    </label>
    <button type="button" on:click={onOpenGoals}>Manage goals</button>
  </header>

  <div class="goal-history-scroll">
    <div class="goal-history-grid" style={`--goal-day-count: ${dates.length}`}>
      <div class="goal-history-corner">Goal</div>
      {#each dates as date (date)}
        <button
          class:today={date === todayISO()}
          class:future={date > todayISO()}
          class="goal-date-head"
          type="button"
          title={date}
          aria-label={`Open ${date}`}
          on:click={() => onSelectDate(date)}
        >
          <span>{dayLabel(date)}</span>
          <strong>{dateLabel(date)}</strong>
        </button>
      {/each}

      {#each visibleGoals as goal (goal.id)}
        {@const cells = buildGoalDayCells(goal, completions, dates)}
        <button
          class="goal-history-name"
          type="button"
          style={`--goal-hue: ${goal.hue}`}
          title={`${goal.name}: every ${goal.cadenceDays} day${goal.cadenceDays === 1 ? '' : 's'}`}
          on:click={onOpenGoals}
        >
          <span class="goal-color-dot"></span>
          <span>{goal.name}</span>
          <small>{goal.cadenceDays}d</small>
        </button>
        {#each cells as cell (cell.date)}
          <button
            class="goal-day-cell"
            class:active={cell.active}
            class:segment-start={cell.segmentStart}
            class:segment-end={cell.segmentEnd}
            class:completed={cell.completed}
            class:relieved={cell.relieved}
            class:missed={cell.missed}
            class:today={cell.date === todayISO()}
            class:future={cell.date > todayISO()}
            style={`--goal-hue: ${goal.hue}`}
            type="button"
            title={`${goal.name} · ${cell.date}${cell.completed ? ' · completed' : cell.active ? ' · active' : ' · inactive'}`}
            aria-label={`${goal.name} on ${cell.date}${cell.completed ? ', completed' : ''}`}
            on:click={() => onSelectDate(cell.date)}
          >
            {#if cell.completed}
              <span class="goal-cell-mark checked">✓</span>
            {:else if cell.relieved}
              <span class="goal-cell-mark relieved-mark">×</span>
            {:else if cell.active}
              <span class="goal-cell-mark open"></span>
            {/if}
          </button>
        {/each}
      {:else}
        <div class="goal-history-empty">
          <span>No goals active in this range.</span>
          <button type="button" on:click={onOpenGoals}>Add your first goal</button>
        </div>
      {/each}
    </div>
  </div>
</section>
