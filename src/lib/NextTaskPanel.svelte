<script lang="ts">
  import { formatMinutes, hasActiveTimeRange, sanitizeInlineHTML } from './planner'
  import type { NextTask } from './nextTask'
  import type { DailyPlan, Id } from './types'

  export let plan: DailyPlan | undefined
  export let next: NextTask | null
  export let onComplete: (planId: Id, itemId: Id) => void
  export let onOpenToday: () => void

  // The task to do now is selected, as on Today; its unfinished parents sit
  // above it so the context and their times stay visible and checkable.
  $: rows = next ? [...next.ancestors, next.item] : []
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
            <div class="next-task-text">{@html sanitizeInlineHTML(row.html)}</div>
            {#if hasActiveTimeRange(row)}
              <span class="next-task-time">{formatMinutes(row.startMinutes)}–{formatMinutes(row.endMinutes)}</span>
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
    width: min(560px, 100%);
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
    .next-task-row.selected .next-task-time {
      margin: 0 0 0 34px;
    }

    .next-task-row.selected .next-task-text {
      font-size: 21px;
    }
  }
</style>
