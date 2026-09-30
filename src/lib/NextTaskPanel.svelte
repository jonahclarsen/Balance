<script lang="ts">
  import { formatMinutes, hasActiveTimeRange, sanitizeInlineHTML } from './planner'
  import type { NextTask } from './nextTask'
  import type { DailyPlan, Id } from './types'

  export let plan: DailyPlan | undefined
  export let next: NextTask | null
  export let onComplete: (planId: Id, itemId: Id) => void
  export let onOpenToday: () => void

  $: safeHTML = next ? sanitizeInlineHTML(next.item.html) : ''
  $: breadcrumb = next?.ancestors.map((ancestor) => ancestor.text.trim()).filter(Boolean).join(' › ') ?? ''

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
      <article class="next-task-card" data-next-task-id={next.item.id}>
        {#if breadcrumb}<p class="next-task-breadcrumb">{breadcrumb}</p>{/if}
        <div class="next-task-body">
          <input
            class="check"
            type="checkbox"
            checked={false}
            aria-label="Complete task"
            title="Complete task"
            on:change={() => plan && next && onComplete(plan.id, next.item.id)}
          />
          <div class="next-task-text">{@html safeHTML}</div>
        </div>
        {#if hasActiveTimeRange(next.item)}
          <p class="next-task-time">{formatMinutes(next.item.startMinutes)}–{formatMinutes(next.item.endMinutes)}</p>
        {/if}
      </article>
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
    padding: 36px 40px;
    border: 1px solid var(--line);
    border-radius: 14px;
    background: var(--paper);
    box-shadow: var(--shadow);
    animation: next-task-enter 220ms ease-out;
  }

  .next-task-breadcrumb,
  .next-task-time {
    margin: 0;
    color: var(--muted);
    font-size: 14px;
  }

  .next-task-body {
    display: flex;
    align-items: flex-start;
    gap: 16px;
  }

  .next-task-body .check {
    flex: none;
    width: 26px;
    height: 26px;
    margin-top: 3px;
  }

  .next-task-text {
    min-width: 0;
    font-family: var(--font-content);
    font-size: 26px;
    font-weight: 600;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }

  .next-task-time {
    padding-left: 42px;
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

    .next-task-text {
      font-size: 21px;
    }
  }
</style>
