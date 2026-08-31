<script lang="ts">
  import { onMount, tick } from 'svelte'
  import {
    buildGoalDayCells,
    filterGoalsByPhrase,
    GOAL_FUTURE_DAYS,
    goalDaysUntilLapse,
    goalLightnessShift,
    isGoalActiveOnDate,
    isoDateDiffDays,
    shiftISODate,
    sortGoalsForRhythm,
  } from './goals'
  import { todayISO } from './planner'
  import type { Goal, GoalCompletion } from './types'

  type GoalRhythmMode = 'flow' | 'mosaic' | 'signal' | 'ledger' | 'aurora'

  const GOAL_RHYTHM_MODE_KEY = 'balance.goalRhythmMode.v1'
  const GOAL_RHYTHM_MODES: Array<{ id: GoalRhythmMode; label: string; glyph: string }> = [
    { id: 'flow', label: 'Flow', glyph: '≋' },
    { id: 'mosaic', label: 'Mosaic', glyph: '▦' },
    { id: 'signal', label: 'Signal', glyph: '•—' },
    { id: 'ledger', label: 'Ledger', glyph: '≡' },
    { id: 'aurora', label: 'Aurora', glyph: '✦' },
  ]

  export let goals: Goal[]
  export let completions: GoalCompletion[]
  export let viewedDate: string = todayISO()
  export let visible = true
  export let onOpenGoals: (goalId?: string) => void
  export let onOpenDate: (date: string) => void
  export let onResizeStart: ((event: PointerEvent) => void) | undefined = undefined
  // A click on a plan item's goal badge sets this to scroll the goal into view.
  export let scrollRequest: { goalId: string; nonce: number } | null = null

  let search = ''
  let rhythmMode: GoalRhythmMode = 'flow'
  let scrollEl: HTMLDivElement | undefined
  let nameScrollEl: HTMLDivElement | undefined
  let namePaneEl: HTMLDivElement | undefined
  let mounted = false
  let lastCenteredStartDate: string | null = null
  let highlightedGoalId: string | null = null
  let copiedGoalId: string | null = null
  let copyResetTimer: ReturnType<typeof setTimeout> | undefined
  let highlightResetTimer: ReturnType<typeof setTimeout> | undefined
  let lastHandledScrollNonce = -1
  let wasVisible = visible
  // Clear the trigger just after the CSS animation ends so its final transparent
  // frame is painted before the class is removed.
  const GOAL_REVEAL_CLEAR_MS = 1700
  // Profiling under CPU contention found 48 days to be the best balance: large
  // enough to avoid delayed paints while scrolling, but still small enough for
  // content-visibility to skip most of the offscreen timeline.
  const DAY_CHUNK_SIZE = 48

  function chunksOf<T>(values: T[]): T[][] {
    const chunks: T[][] = []
    for (let index = 0; index < values.length; index += DAY_CHUNK_SIZE) {
      chunks.push(values.slice(index, index + DAY_CHUNK_SIZE))
    }
    return chunks
  }

  $: if (visible !== wasVisible) {
    wasVisible = visible
    if (visible) {
      refreshDay()
    } else {
      // IMAX keeps the expensive history grid mounted while it is hidden. Reset
      // the same transient state that destroying the component used to clear so
      // toggling IMAX does not change the panel's user-visible behavior.
      search = ''
      highlightedGoalId = null
      copiedGoalId = null
      lastCenteredStartDate = null
      lastHandledScrollNonce = -1
      if (copyResetTimer) clearTimeout(copyResetTimer)
      if (highlightResetTimer) clearTimeout(highlightResetTimer)
      copyResetTimer = undefined
      highlightResetTimer = undefined
      if (scrollEl) {
        scrollEl.scrollLeft = 0
        scrollEl.scrollTop = 0
      }
      if (nameScrollEl) nameScrollEl.scrollTop = 0
    }
  }

  $: if (visible && scrollRequest && scrollRequest.nonce !== lastHandledScrollNonce) {
    lastHandledScrollNonce = scrollRequest.nonce
    revealGoal(scrollRequest.goalId, scrollRequest.nonce)
  }

  async function revealGoal(goalId: string, nonce: number) {
    search = ''
    highlightedGoalId = null
    if (highlightResetTimer) clearTimeout(highlightResetTimer)

    await tick()
    // Opening Goal Rhythm changes its shell row from 0px to its saved height.
    // Measure only after that layout and the synchronized pane sizes settle.
    await nextAnimationFrame()
    await nextAnimationFrame()
    if (lastHandledScrollNonce !== nonce) return
    const row = nameScrollEl?.querySelector<HTMLElement>(`[data-goal-id="${CSS.escape(goalId)}"]`)
    if (!row || !scrollEl || !nameScrollEl) return

    highlightedGoalId = goalId
    highlightResetTimer = setTimeout(() => {
      if (lastHandledScrollNonce === nonce && highlightedGoalId === goalId) highlightedGoalId = null
    }, GOAL_REVEAL_CLEAR_MS)
    // Paint the highlight at the row's current position before moving it. Two
    // frames let the class flush and render once before the centering jump.
    await tick()
    await nextAnimationFrame()
    await nextAnimationFrame()
    if (lastHandledScrollNonce !== nonce) return

    centerGoalRow(row)
    await nextAnimationFrame()
    if (lastHandledScrollNonce !== nonce) return
    // Recalculate from rendered rectangles once after scrolling. This absorbs
    // scrollbar sizing and content-visibility realization without relying on
    // offsetParent geometry.
    centerGoalRow(row)

    await nextAnimationFrame()
    if (lastHandledScrollNonce !== nonce) return
  }

  function centerGoalRow(row: HTMLElement) {
    if (!scrollEl || !nameScrollEl) return

    const viewportRect = nameScrollEl.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const centeredTop = nameScrollEl.scrollTop
      + rowRect.top
      - viewportRect.top
      - (nameScrollEl.clientHeight - rowRect.height) / 2
    const maxTop = Math.max(0, nameScrollEl.scrollHeight - nameScrollEl.clientHeight)
    const targetTop = Math.max(0, Math.min(maxTop, Math.round(centeredTop)))

    // Move both panes together. Letting their reciprocal scroll handlers drive
    // this jump can leave one pane at an intermediate position.
    nameScrollEl.scrollTop = targetTop
    scrollEl.scrollTop = targetTop
  }

  function nextAnimationFrame() {
    return new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  }

  // Track Balance's 3am day boundary reactively so the grid keeps the current
  // day highlighted after the date rolls over while the app stays open.
  let today = todayISO()

  $: activeGoals = goals.filter((goal) => isGoalActiveOnDate(goal, today))
  $: firstGoalDate = activeGoals.reduce<string | null>((earliest, goal) => {
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
  $: dateChunks = chunksOf(dates)
  $: upcomingGoalCount = activeGoals.filter((goal) => {
    const daysUntilLapse = goalDaysUntilLapse(goal, completions, viewedDate)
    return daysUntilLapse !== null && daysUntilLapse <= 3
  }).length
  $: visibleGoals = filterGoalsByPhrase(
    sortGoalsForRhythm(
      activeGoals,
      completions,
      viewedDate,
    ),
    search,
  )

  $: if (mounted && visible && historyStartDate !== lastCenteredStartDate) {
    lastCenteredStartDate = historyStartDate
    centerCurrentDay()
  }

  async function centerCurrentDay() {
    await tick()
    if (!scrollEl) return

    const currentDayHead = scrollEl.querySelector<HTMLElement>(`[data-goal-date="${today}"]`)
    if (!currentDayHead) return

    const scrollRect = scrollEl.getBoundingClientRect()
    const currentDayRect = currentDayHead.getBoundingClientRect()
    const currentDayCenter = currentDayRect.left - scrollRect.left + scrollEl.scrollLeft + currentDayRect.width / 2
    scrollEl.scrollLeft = currentDayCenter - scrollEl.clientWidth / 2
    syncTimelineScroll()
  }

  function syncTimelineScroll() {
    if (!scrollEl || !nameScrollEl) return
    if (nameScrollEl.scrollTop !== scrollEl.scrollTop) nameScrollEl.scrollTop = scrollEl.scrollTop

    // Keep both vertical viewports the same height when a classic horizontal
    // scrollbar consumes space in the timeline pane.
    const scrollbarHeight = scrollEl.offsetHeight - scrollEl.clientHeight
    namePaneEl?.style.setProperty('--goal-scrollbar-height', `${scrollbarHeight}px`)
  }

  function syncNameScroll() {
    if (!scrollEl || !nameScrollEl || scrollEl.scrollTop === nameScrollEl.scrollTop) return
    scrollEl.scrollTop = nameScrollEl.scrollTop
  }

  function refreshDay() {
    const activeDay = todayISO()
    if (activeDay !== today) today = activeDay
  }

  onMount(() => {
    mounted = true

    const storedRhythmMode = localStorage.getItem(GOAL_RHYTHM_MODE_KEY)
    if (GOAL_RHYTHM_MODES.some((mode) => mode.id === storedRhythmMode)) {
      rhythmMode = storedRhythmMode as GoalRhythmMode
    }

    const dayTimer = setInterval(refreshDay, 60_000)
    window.addEventListener('focus', refreshDay)
    document.addEventListener('visibilitychange', refreshDay)
    return () => {
      clearInterval(dayTimer)
      if (copyResetTimer) clearTimeout(copyResetTimer)
      if (highlightResetTimer) clearTimeout(highlightResetTimer)
      window.removeEventListener('focus', refreshDay)
      document.removeEventListener('visibilitychange', refreshDay)
    }
  })

  function changeRhythmMode(event: Event) {
    const nextMode = (event.currentTarget as HTMLSelectElement).value
    if (!GOAL_RHYTHM_MODES.some((mode) => mode.id === nextMode)) return
    rhythmMode = nextMode as GoalRhythmMode
    localStorage.setItem(GOAL_RHYTHM_MODE_KEY, rhythmMode)
  }

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

<section
  class="goal-history-panel"
  aria-label="Goal history"
  data-rhythm-mode={rhythmMode}
  hidden={!visible}
>
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
    <label class="goal-rhythm-mode-pill" title="Change Goal Rhythm style">
      <span class="goal-rhythm-mode-glyph" aria-hidden="true">
        {GOAL_RHYTHM_MODES.find((mode) => mode.id === rhythmMode)?.glyph}
      </span>
      <select aria-label="Goal rhythm style" value={rhythmMode} on:change={changeRhythmMode}>
        {#each GOAL_RHYTHM_MODES as mode (mode.id)}
          <option value={mode.id}>{mode.label}</option>
        {/each}
      </select>
    </label>
    <div class="goal-history-title">
      <strong>Goal rhythm</strong>
      <span>{upcomingGoalCount} upcoming in the next 3 days</span>
    </div>
    <div class="goal-history-search-field">
      <input
        class="goal-history-search"
        type="search"
        aria-label="Search goals"
        placeholder="Search goals…"
        bind:value={search}
      />
      {#if search}
        <button
          class="goal-history-search-clear"
          type="button"
          aria-label="Clear goal search"
          title="Clear search"
          on:click={() => (search = '')}
        >×</button>
      {/if}
    </div>
    <button type="button" on:click={() => onOpenGoals()}>Manage goals</button>
  </header>

  <div class="goal-history-body">
    <div class="goal-history-name-pane" bind:this={namePaneEl}>
      <div class="goal-history-corner">Goal</div>
      <div class="goal-history-name-scroll" bind:this={nameScrollEl} on:scroll={syncNameScroll}>
        <div class="goal-history-name-list">
          {#each visibleGoals as goal (goal.id)}
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
    </div>

    <div class="goal-history-scroll" bind:this={scrollEl} on:scroll={syncTimelineScroll}>
      <div class="goal-history-grid">
        <div class="goal-history-date-row">
          {#each dateChunks as dateChunk (dateChunk[0])}
            <div class="goal-history-day-chunk" style={`--goal-chunk-day-count: ${dateChunk.length}`}>
              {#each dateChunk as date (date)}
                <button
                  type="button"
                  class:viewed={date === viewedDate}
                  class:today={date === today}
                  class:future={date > today}
                  class="goal-date-head"
                  data-goal-date={date}
                  aria-label={`Open ${date} in Today view`}
                  title={`Open ${date} in Today view`}
                  on:click={() => onOpenDate(date)}
                >
                  <span>{dayLabel(date)}</span>
                  <strong>{dateLabel(date)}</strong>
                </button>
              {/each}
            </div>
          {/each}
        </div>

        {#each visibleGoals as goal (goal.id)}
          {@const cells = buildGoalDayCells(goal, completions, dates, today)}
          <div class="goal-history-day-row">
            {#each chunksOf(cells) as cellChunk (cellChunk[0].date)}
              <div class="goal-history-day-chunk" style={`--goal-chunk-day-count: ${cellChunk.length}`}>
                {#each cellChunk as cell (cell.date)}
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
              </div>
            {/each}
          </div>
        {/each}
      </div>
    </div>
  </div>
</section>
