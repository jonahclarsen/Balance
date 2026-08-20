<script lang="ts">
  import PlanItemEditor from './PlanItemEditor.svelte'
  import type { PlanItem } from './types'

  export let mobile = false

  const previewPlanId = 'theme-preview-plan'
  const previewItems: PlanItem[] = [
    {
      id: 'theme-preview-laundry-negotiation',
      text: 'Negotiate a peace treaty with the laundry chair',
      html: 'Negotiate a peace treaty with the laundry chair',
      done: false,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      children: [],
    },
    {
      id: 'theme-preview-plant-apology',
      text: 'Apologize to the houseplants for the quarterly results',
      html: 'Apologize to the houseplants for the quarterly results',
      done: true,
      startMinutes: null,
      endMinutes: null,
      children: [],
    },
  ]

  const timeWarnings = new Map()
</script>

<div class="theme-task-preview">
  <p class="theme-task-preview-label">Live preview</p>
  <div class="list-panel theme-task-preview-list" inert aria-hidden="true">
    {#each previewItems as item (item.id)}
      <PlanItemEditor
        {item}
        allItems={previewItems}
        {timeWarnings}
        planId={previewPlanId}
        patchItem={() => {}}
        splitItem={() => item.id}
        deleteItem={() => {}}
        moveItem={() => {}}
        moveItemWithinLevel={() => {}}
        outdentItem={() => {}}
        historyRevision={0}
        {mobile}
      />
    {/each}
  </div>
</div>

<style>
  .theme-task-preview {
    display: grid;
    gap: 7px;
  }

  .theme-task-preview-label {
    color: var(--muted);
    font-size: 11px;
    font-weight: 800;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .theme-task-preview-list {
    padding-block: 5px;
  }
</style>
