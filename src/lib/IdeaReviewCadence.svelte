<script lang="ts">
  import { ideaReviewDays, IDEA_REVIEW_MAX_DAYS, parseIdeaReviewDays, type ScheduledIdeaReviewKind } from './ideas'
  import { plannerStore } from './store'
  import type { IdeaGroup } from './types'

  export let kind: ScheduledIdeaReviewKind
  export let groups: IdeaGroup[]
  export let label: string

  $: days = ideaReviewDays(groups, kind)

  // Invalid entries snap back to the saved cadence.
  function commit(input: HTMLInputElement) {
    const next = parseIdeaReviewDays(input.value)
    if (next !== null && next !== days) plannerStore.setIdeaReviewDays(kind, next)
    else input.value = String(days)
  }

  function handleKeydown(event: KeyboardEvent & { currentTarget: HTMLInputElement }) {
    if (event.key !== 'Enter' && event.key !== 'Escape') return
    event.preventDefault()
    if (event.key === 'Escape') event.currentTarget.value = String(days)
    event.currentTarget.blur()
  }
</script>

<label class="idea-review-cadence" title="Scheduled review">
  Every
  <input
    type="number"
    inputmode="numeric"
    min="1"
    max={IDEA_REVIEW_MAX_DAYS}
    step="1"
    value={days}
    aria-label={`${label} review days`}
    on:change={(event) => commit(event.currentTarget)}
    on:keydown={handleKeydown}
  />
  days
</label>

<style>
  .idea-review-cadence {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }
  .idea-review-cadence input {
    width: 3.5em;
    min-height: 0;
    padding: 1px 4px;
    font-size: 12px;
    text-align: right;
    font-variant-numeric: tabular-nums;
  }
</style>
