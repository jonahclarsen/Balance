<script lang="ts">
  import { onMount, tick } from 'svelte'
  import {
    buildGoalDayCells,
    GOAL_FUTURE_DAYS,
    goalDaysUntilLapse,
    GOAL_HISTORY_DEFAULT_DAYS,
    GOAL_HISTORY_MAX_DAYS,
    goalWasActiveInRange,
    isoDateDiffDays,
    shiftISODate,
    sortGoalsByUrgency,
    visibleGoalDates,
  } from './goals'
  import { currentDayISO, todayISO } from './planner'
  import type { Goal, GoalCompletion } from './types'

  const HISTORY_DAYS_KEY = 'balance.goalHistoryDays'

  export let goals: Goal[]
  export let completions: GoalCompletion[]
  export let viewedDate: string = todayISO()
  export let onOpenGoals: () => void
  export let onResizeStart: ((event: PointerEvent) => void) | undefined = undefined
  // A click on a plan item's goal badge sets this to scroll the goal into view.
  export let scrollRequest: { goalId: string; nonce: number } | null = null

  let historyDays = GOAL_HISTORY_DEFAULT_DAYS
  let scrollEl: HTMLDivElement | undefined
  let highlightedGoalId: string | null = null
  let lastHandledScrollNonce = -1

  $: if (scrollRequest && scrollRequest.nonce !== lastHandledScrollNonce) {
    lastHandledScrollNonce = scrollRequest.nonce
    revealGoal(scrollRequest.goalId)
  }

  async function revealGoal(goalId: string) {
    await tick()
    const row = scrollEl?.querySelector<HTMLElement>(`[data-goal-id="${goalId}"]`)
    if (!row) return
    row.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' })
    highlightedGoalId = goalId
    setTimeout(() => {
      if (highlightedGoalId === goalId) highlightedGoalId = null
    }, 1600)
  }

  // Track the wall-clock day reactively so the grid keeps a column for the
  // current day after the date rolls over while the app stays open — otherwise
  // the date list only refreshes when an input like the Days slider changes.
  // `today` is the calendar day (drives the grid); `currentDay` rolls over at
  // 4am and is only used to bold the active day on the date row.
  let today = todayISO()
  let currentDay = currentDayISO()

  $: pastDates = visibleGoalDates(historyDays, today)
  // The grid always reaches GOAL_FUTURE_DAYS past the viewed day; when
  // viewing the past that range is already covered by the history dates.
  $: futureDayCount = Math.max(0, isoDateDiffDays(today, viewedDate) + GOAL_FUTURE_DAYS)
  $: futureDates = Array.from({ length: futureDayCount }, (_, index) => shiftISODate(today, index + 1))
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

  function refreshDay() {
    const calendarDay = todayISO()
    if (calendarDay !== today) today = calendarDay
    const activeDay = currentDayISO()
    if (activeDay !== currentDay) currentDay = activeDay
  }

  onMount(() => {
    const stored = Number(localStorage.getItem(HISTORY_DAYS_KEY))
    if (Number.isFinite(stored) && stored >= 1) historyDays = Math.min(GOAL_HISTORY_MAX_DAYS, Math.round(stored))

    const dayTimer = setInterval(refreshDay, 60_000)
    window.addEventListener('focus', refreshDay)
    document.addEventListener('visibilitychange', refreshDay)
    return () => {
      clearInterval(dayTimer)
      window.removeEventListener('focus', refreshDay)
      document.removeEventListener('visibilitychange', refreshDay)
    }
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

  <div class="goal-history-scroll" bind:this={scrollEl}>
    <div class="goal-history-grid" style={`--goal-day-count: ${dates.length}`}>
      <div class="goal-history-corner">Goal</div>
      {#each dates as date (date)}
        <div
          class:viewed={date === viewedDate}
          class:today={date === currentDay}
          class:future={date > today}
          class="goal-date-head"
          title={date}
        >
          <span>{dayLabel(date)}</span>
          <strong>{dateLabel(date)}</strong>
        </div>
      {/each}

      {#each visibleGoals as goal (goal.id)}
        {@const cells = buildGoalDayCells(goal, completions, dates, today)}
        {@const daysUntilLapse = goalDaysUntilLapse(goal, completions, viewedDate)}
        <button
          class="goal-history-name"
          class:goal-row-focus={highlightedGoalId === goal.id}
          data-goal-id={goal.id}
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
            class:future={cell.date > today}
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
