<script lang="ts">
  import { openExternalURL } from './externalLinks'
  import { goalLightnessShift, goalsMatchingItemText } from './goals'
  import { formatMinutes, hasActiveTimeRange, isURL, itemLinkFromAnchor, linkifyItemText, renderItemDisplayHTML, type ItemLink } from './planner'
  import type { NextTask } from './nextTask'
  import type { DailyPlan, Goal, Id, ListTemplate, Metric, Note } from './types'

  export let plan: DailyPlan | undefined
  export let next: NextTask | null
  export let goals: Goal[]
  export let listTemplates: ListTemplate[]
  export let metrics: Metric[]
  export let notes: Note[]
  export let onComplete: (planId: Id, itemId: Id) => void
  export let onOpenLink: (link: ItemLink, itemId: Id) => void
  export let onGoalClick: (goalId: Id) => void
  export let onOpenToday: () => void

  // The task to do now is selected, as on Today; its unfinished parents sit
  // above it so the context and their times stay visible and checkable.
  $: rows = next ? [...next.ancestors, next.item] : []

  function displayHTML(row: NextTask['item']) {
    return renderItemDisplayHTML(row.html, row.text, linkifyItemText(row.text, listTemplates, metrics, notes))
  }

  // The text renders via {@html}, so route its links explicitly instead of
  // letting the webview navigate away.
  async function handleLinkClick(event: MouseEvent, itemId: Id) {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
    if (!anchor) return
    const link = itemLinkFromAnchor(anchor)
    if (link) {
      event.preventDefault()
      onOpenLink(link, itemId)
      return
    }
    if (!isURL(anchor.href)) return
    event.preventDefault()
    await openExternalURL(anchor.href)
  }
</script>

<section class="next-task-page" aria-label="Next task">
  {#if !plan}
    <div class="next-task-card next-task-empty">
      <p>No plan for today yet.</p>
      <button type="button" on:click={onOpenToday}>Open Today</button>
    </div>
  {:else if !next}
    <div class="next-task-card next-task-empty">
      <p>All done for today.</p>
    </div>
  {:else}
    {#key next.item.id}
      <ol class="next-task-card next-task-rows">
        {#each rows as row, depth (row.id)}
          <li
            class="next-task-row"
            class:selected={row === next.item}
            style:--depth={depth}
            data-next-task-id={row.id}
            aria-current={row === next.item ? 'step' : undefined}
          >
            <input
              class="check"
              type="checkbox"
              checked={false}
              aria-label={`Complete ${row.text || 'task'}`}
              title="Complete task"
              on:change={() => plan && onComplete(plan.id, row.id)}
            />
            <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
            <div class="next-task-text" on:click={(event) => handleLinkClick(event, row.id)}>{@html displayHTML(row)}</div>
            {#if hasActiveTimeRange(row)}
              <span class="next-task-time">{formatMinutes(row.startMinutes)}–{formatMinutes(row.endMinutes)}</span>
            {/if}
            {#if plan}
              {@const rowGoals = goalsMatchingItemText(row, goals, plan.date)}
              {#if rowGoals.length > 0}
                <div class="plan-goal-badges next-task-goals" aria-label="Goals matched by this item">
                  {#each rowGoals as goal (goal.id)}
                    <button
                      type="button"
                      class="plan-goal-badge"
                      style={`--goal-hue: ${goal.hue}; --goal-lightness-shift: ${goalLightnessShift(goal.lightness)}%`}
                      title={`Will complete goal: ${goal.name} — show in Goals`}
                      aria-label={`${goal.name} — show in Goals`}
                      on:click={() => onGoalClick(goal.id)}
                    >{goal.name}</button>
                  {/each}
                </div>
              {/if}
            {/if}
          </li>
        {/each}
      </ol>
    {/key}
  {/if}
</section>

<style>
  .next-task-page {
    display: grid;
    place-items: center;
    min-height: 100%;
    padding: 24px 0;
  }

  .next-task-card {
    display: grid;
    gap: 14px;
    width: min(680px, 100%);
    padding: 28px 30px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--paper);
    box-shadow: var(--shadow);
    animation: next-task-enter 220ms ease-out;
  }

  .next-task-rows {
    gap: 6px;
    margin: 0;
    list-style: none;
  }

  .next-task-row {
    display: flex;
    align-items: flex-start;
    gap: 12px;
    margin-left: calc(var(--depth) * 28px);
    padding: 6px 10px;
    border-radius: 8px;
    color: var(--muted);
  }

  .next-task-row .check {
    flex: none;
    margin-top: 3px;
  }

  .next-task-text {
    flex: 1;
    min-width: 0;
    font-family: var(--font-content);
    font-size: 17px;
    line-height: 1.35;
    overflow-wrap: anywhere;
  }

  .next-task-time {
    flex: none;
    padding: 1px 6px;
    border: 1px solid var(--time-border);
    border-radius: 6px;
    background: var(--time-bg);
    color: var(--accent-strong);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
    line-height: 1.5;
  }

  .next-task-goals {
    flex: none;
    margin: 2px 0 0;
  }

  .next-task-row.selected .next-task-goals {
    margin-top: 8px;
  }

  .next-task-row.selected {
    padding-block: 12px;
    background: color-mix(in srgb, var(--drop-inside) 72%, transparent);
    box-shadow: inset 3px 0 0 var(--accent);
    color: var(--ink);
  }

  .next-task-row.selected .check {
    width: 24px;
    height: 24px;
    margin-top: 4px;
  }

  .next-task-row.selected .next-task-text {
    font-size: 26px;
    font-weight: 600;
    line-height: 1.3;
  }

  .next-task-row.selected .next-task-time {
    margin-top: 6px;
  }

  .next-task-empty {
    justify-items: center;
    text-align: center;
  }

  .next-task-empty p {
    margin: 0;
    color: var(--muted);
    font-size: 18px;
  }

  @keyframes next-task-enter {
    from {
      opacity: 0;
      transform: translateY(6px);
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .next-task-card {
      animation: none;
    }
  }

  @media (max-width: 760px) {
    .next-task-card {
      padding: 24px;
    }

    .next-task-row {
      flex-wrap: wrap;
      margin-left: calc(var(--depth) * 18px);
    }

    .next-task-text {
      flex-basis: calc(100% - 40px);
    }

    .next-task-time,
    .next-task-row.selected .next-task-time,
    .next-task-goals,
    .next-task-row.selected .next-task-goals {
      margin: 0 0 0 34px;
    }

    .next-task-row.selected .next-task-text {
      font-size: 21px;
    }
  }
</style>
