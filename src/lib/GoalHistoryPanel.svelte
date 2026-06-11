<script lang="ts">
  import { onMount } from 'svelte'
  import {
    buildGoalDayCells,
    goalDaysUntilLapse,
    GOAL_HISTORY_DEFAULT_DAYS,
    GOAL_HISTORY_MAX_DAYS,
    goalWasActiveInRange,
    shiftISODate,
    sortGoalsByUrgency,
    visibleGoalDates,
  } from './goals'
  import { todayISO } from './planner'
  import type { Goal, GoalCompletion } from './types'

  const HISTORY_DAYS_KEY = 'balance.goalHistoryDays'

  export let goals: Goal[]
  export let completions: GoalCompletion[]
  export let viewedDate: string = todayISO()
  export let onOpenGoals: () => void
  export let onResizeStart: ((event: PointerEvent) => void) | undefined = undefined

  let historyDays = GOAL_HISTORY_DEFAULT_DAYS

  $: pastDates = visibleGoalDates(historyDays)
  $: futureDayCount = Math.max(0, ...goals.map((goal) => goal.cadenceDays - 1))
  $: futureDates = Array.from({ length: futureDayCount }, (_, index) => shiftISODate(todayISO(), index + 1))
  $: dates = [...pastDates, ...futureDates]
  $: upcomingGoalCount = goals.filter((goal) => {
    const daysUntilLapse = goalDaysUntilLapse(goal, completions, viewedDate)
    return daysUntilLapse !== null && daysUntilLapse <= 3
  }).length
  $: visibleGoals = sortGoalsByUrgency(
    goals.filter((goal) => goalWasActiveInRange(goal, dates)),
    completions,
    viewedDate,
  )

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

  function lapseLabel(days: number | null): string {
    if (days === null) return ''
    if (days < 0) return `${Math.abs(days)}d over`
    if (days === 0) return 'due today'
    return `${days}d left`
  }

  function lapseTooltip(days: number | null): string {
    if (days === null) return ''
    if (days < 0) return `\nDefaulted ${Math.abs(days)} day${days === -1 ? '' : 's'} ago`
    if (days === 0) return '\nDue today to stay on track'
    return `\n${days} day${days === 1 ? '' : 's'} left before default`
  }
</script>

<section class="goal-history-panel" aria-label="Goal history">
  {#if onResizeStart}
    <div
      class="goal-history-resize-handle"
      role="separator"
      aria-label="Resize goal rhythm panel"
      aria-orientation="horizontal"
      on:pointerdown={onResizeStart}
    ></div>
  {/if}
  <header class="goal-history-toolbar">
    <div>
      <strong>Goal rhythm</strong>
      <span>{upcomingGoalCount} upcoming in the next 3 days</span>
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
        <div
          class:viewed={date === viewedDate}
          class:future={date > todayISO()}
          class="goal-date-head"
          title={date}
        >
          <span>{dayLabel(date)}</span>
          <strong>{dateLabel(date)}</strong>
        </div>
      {/each}

      {#each visibleGoals as goal (goal.id)}
        {@const cells = buildGoalDayCells(goal, completions, dates)}
        {@const daysUntilLapse = goalDaysUntilLapse(goal, completions, viewedDate)}
        <button
          class="goal-history-name"
          type="button"
          style={`--goal-hue: ${goal.hue}; --goal-sat-factor: ${goal.neutral ? 0 : 1}`}
          title={`${goal.name}: every ${goal.cadenceDays} day${goal.cadenceDays === 1 ? '' : 's'}${lapseTooltip(daysUntilLapse)}\nMatch keywords: ${goal.matchTerms.join(', ')}`}
          on:click={onOpenGoals}
        >
          <span class="goal-color-dot"></span>
          <span>{goal.name}</span>
          <small>{goal.cadenceDays}d</small>
          {#if daysUntilLapse !== null}
            <small class="goal-lapse" class:overdue={daysUntilLapse <= 0}>{lapseLabel(daysUntilLapse)}</small>
          {/if}
        </button>
        {#each cells as cell (cell.date)}
          <div
            class="goal-day-cell"
            class:active={cell.active}
            class:segment-start={cell.segmentStart}
            class:segment-end={cell.segmentEnd}
            class:current-period={cell.current}
            class:completed={cell.completed}
            class:relieved={cell.relieved}
            class:missed={cell.missed}
            class:overdue={cell.overdue}
            class:viewed={cell.date === viewedDate}
            class:future={cell.date > todayISO()}
            style={`--goal-hue: ${goal.hue}; --goal-sat-factor: ${goal.neutral ? 0 : 1}`}
            title={`${goal.name} · ${cell.date}${cell.completed ? ' · completed' : cell.overdue ? ' · overdue' : cell.missed ? ' · missed' : cell.active ? ' · active' : ' · inactive'}`}
          >
            {#if cell.completed}
              <span class="goal-cell-mark checked">✓</span>
            {:else if cell.relieved}
              <span class="goal-cell-mark relieved-mark">×</span>
            {:else if cell.active}
              <span class="goal-cell-mark open"></span>
            {/if}
          </div>
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
