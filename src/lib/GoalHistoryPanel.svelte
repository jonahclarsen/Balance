<script lang="ts">
  import { onMount, tick } from 'svelte'
  import {
    buildGoalDayCells,
    filterGoalsByPhrase,
    GOAL_FUTURE_DAYS,
    goalDaysUntilLapse,
    goalLightnessShift,
    goalWasActiveInRange,
    isoDateDiffDays,
    shiftISODate,
    sortGoalsByUrgency,
  } from './goals'
  import { currentDayISO, todayISO } from './planner'
  import type { Goal, GoalCompletion } from './types'

  export let goals: Goal[]
  export let completions: GoalCompletion[]
  export let viewedDate: string = todayISO()
  export let onOpenGoals: (goalId?: string) => void
  export let onResizeStart: ((event: PointerEvent) => void) | undefined = undefined
  // A click on a plan item's goal badge sets this to scroll the goal into view.
  export let scrollRequest: { goalId: string; nonce: number } | null = null

  let search = ''
  let scrollEl: HTMLDivElement | undefined
  let mounted = false
  let lastCenteredStartDate: string | null = null
  let highlightedGoalId: string | null = null
  let copiedGoalId: string | null = null
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined
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
  // current day after the date rolls over while the app stays open.
  // `today` is the calendar day (drives the grid); `currentDay` rolls over at
  // 4am and is only used to bold the active day on the date row.
  let today = todayISO()
  let currentDay = currentDayISO()

  $: firstGoalDate = goals.reduce<string | null>((earliest, goal) => {
    for (const period of goal.activityPeriods) {
      if (!earliest || period.startDate < earliest) earliest = period.startDate
    }
    return earliest
  }, null)
  $: historyStartDate = firstGoalDate && firstGoalDate < today ? firstGoalDate : today
  $: pastDayCount = isoDateDiffDays(historyStartDate, today) + 1
  $: pastDates = Array.from({ length: pastDayCount }, (_, index) => shiftISODate(historyStartDate, index))
  // The grid always reaches GOAL_FUTURE_DAYS past the viewed day; when
  // viewing the past that range is already covered by the history dates.
  $: futureDayCount = Math.max(0, isoDateDiffDays(today, viewedDate) + GOAL_FUTURE_DAYS)
  $: futureDates = Array.from({ length: futureDayCount }, (_, index) => shiftISODate(today, index + 1))
  $: dates = [...pastDates, ...futureDates]
  $: upcomingGoalCount = goals.filter((goal) => {
    const daysUntilLapse = goalDaysUntilLapse(goal, completions, viewedDate)
    return daysUntilLapse !== null && daysUntilLapse <= 3
  }).length
  $: visibleGoals = filterGoalsByPhrase(
    sortGoalsByUrgency(
      goals.filter((goal) => goalWasActiveInRange(goal, dates)),
      completions,
      viewedDate,
    ),
    search,
  )

  $: if (mounted && historyStartDate !== lastCenteredStartDate) {
    lastCenteredStartDate = historyStartDate
    centerCurrentDay()
  }

  async function centerCurrentDay() {
    await tick()
    if (!scrollEl) return

    const currentDayHead = scrollEl.querySelector<HTMLElement>(`[data-goal-date="${today}"]`)
    if (!currentDayHead) return

    const stickyGoalColumn = scrollEl.querySelector<HTMLElement>('.goal-history-corner')
    const stickyWidth = stickyGoalColumn?.offsetWidth ?? 0
    const visibleDateWidth = scrollEl.clientWidth - stickyWidth
    const targetCenter =
      visibleDateWidth > 0 ? stickyWidth + visibleDateWidth / 2 : scrollEl.clientWidth / 2
    scrollEl.scrollLeft = currentDayHead.offsetLeft + currentDayHead.offsetWidth / 2 - targetCenter
  }

  function refreshDay() {
    const calendarDay = todayISO()
    if (calendarDay !== today) today = calendarDay
    const activeDay = currentDayISO()
    if (activeDay !== currentDay) currentDay = activeDay
  }

  onMount(() => {
    mounted = true

    const dayTimer = setInterval(refreshDay, 60_000)
    window.addEventListener('focus', refreshDay)
    document.addEventListener('visibilitychange', refreshDay)
    return () => {
      clearInterval(dayTimer)
      if (copyResetTimer) clearTimeout(copyResetTimer)
      window.removeEventListener('focus', refreshDay)
      document.removeEventListener('visibilitychange', refreshDay)
    }
  })

  async function copyGoalName(event: MouseEvent, goal: Goal) {
    event.stopPropagation()
    await navigator.clipboard?.writeText(goal.name)
    copiedGoalId = goal.id
    if (copyResetTimer) clearTimeout(copyResetTimer)
    copyResetTimer = setTimeout(() => {
      if (copiedGoalId === goal.id) copiedGoalId = null
    }, 1200)
  }

  function handleGoalNameKeydown(event: KeyboardEvent, goalId: string) {
    if (event.key !== 'Enter' && event.key !== ' ') return
    event.preventDefault()
    onOpenGoals(goalId)
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
    <input
      class="goal-history-search"
      type="search"
      aria-label="Search goals"
      placeholder="Search goals…"
      bind:value={search}
    />
    <button type="button" on:click={() => onOpenGoals()}>Manage goals</button>
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
          data-goal-date={date}
          title={date}
        >
          <span>{dayLabel(date)}</span>
          <strong>{dateLabel(date)}</strong>
        </div>
      {/each}

      {#each visibleGoals as goal (goal.id)}
        {@const cells = buildGoalDayCells(goal, completions, dates, today)}
        {@const daysUntilLapse = goalDaysUntilLapse(goal, completions, viewedDate)}
        <div
          class="goal-history-name"
          class:goal-row-focus={highlightedGoalId === goal.id}
          data-goal-id={goal.id}
          role="button"
          tabindex="0"
          style={`--goal-hue: ${goal.hue}; --goal-lightness-shift: ${goalLightnessShift(goal.lightness)}%`}
          title={`${goal.name}: every ${goal.cadenceDays} day${goal.cadenceDays === 1 ? '' : 's'}${lapseTooltip(daysUntilLapse)}\nMatch keywords: ${goal.matchTerms.join(', ')}`}
          on:click={() => onOpenGoals(goal.id)}
          on:keydown={(event) => handleGoalNameKeydown(event, goal.id)}
        >
          <span class="goal-color-dot"></span>
          <span>{goal.name}</span>
          <button
            class="goal-copy-button"
            type="button"
            aria-label={`Copy ${goal.name}`}
            title={copiedGoalId === goal.id ? 'Copied goal name' : 'Copy goal name'}
            on:click={(event) => copyGoalName(event, goal)}
            on:keydown={(event) => event.stopPropagation()}
          >
            {#if copiedGoalId === goal.id}
              <span aria-hidden="true">✓</span>
            {:else}
              <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                <path d="M9 5h6" />
                <path d="M9 4h6a2 2 0 0 1 2 2v1H7V6a2 2 0 0 1 2-2Z" />
                <path d="M7 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1" />
              </svg>
            {/if}
          </button>
          <small>{goal.cadenceDays}d</small>
          {#if daysUntilLapse !== null}
            <small class="goal-lapse" class:overdue={daysUntilLapse <= 0}>{lapseLabel(daysUntilLapse)}</small>
          {/if}
        </div>
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
            style={`--goal-hue: ${goal.hue}; --goal-lightness-shift: ${goalLightnessShift(goal.lightness)}%`}
            title={`${goal.name} · ${cell.date}${cell.completed ? ' · completed' : cell.overdue ? ' · overdue' : cell.missed ? ' · missed' : cell.active ? ' · active' : ' · inactive'}`}
          >
            {#if cell.completed}
              <span class="goal-cell-mark checked">✓</span>
            {:else if cell.relieved}
              <span class="goal-cell-mark relieved-mark">✓</span>
            {:else if cell.overdue}
              <span class="goal-cell-mark overdue-mark">×</span>
            {:else if cell.active}
              <span class="goal-cell-mark open"></span>
            {/if}
          </div>
        {/each}
      {:else}
        <div class="goal-history-empty">
          {#if search.trim()}
            <span>No goals match “{search.trim()}”.</span>
            <button type="button" on:click={() => (search = '')}>Clear search</button>
          {:else}
            <span>No goals active in this range.</span>
            <button type="button" on:click={() => onOpenGoals()}>Add your first goal</button>
          {/if}
        </div>
      {/each}
    </div>
  </div>
</section>
