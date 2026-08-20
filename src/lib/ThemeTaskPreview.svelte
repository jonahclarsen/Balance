<script lang="ts">
  import PlanItemEditor from './PlanItemEditor.svelte'
  import type { PlanItem } from './types'

  export let mobile = false

  const previewPlanId = 'theme-preview-plan'
  const previewItems: PlanItem[] = [
    {
      id: 'theme-preview-completed',
      text: 'Return Thing Three to the Cat in the Hat before anyone counts',
      html: 'Return Thing Three to the Cat in the Hat before anyone counts',
      done: true,
      startMinutes: null,
      endMinutes: null,
      children: [],
    },
    {
      id: 'theme-preview-timed',
      text: 'Cross-examine the moon about who put soup in my shoes',
      html: 'Cross-examine the moon about who put soup in my shoes',
      done: false,
      startMinutes: 9 * 60,
      endMinutes: 9 * 60 + 30,
      children: [],
    },
  ]

  const timeWarnings = new Map()
</script>

<div class="theme-task-preview">
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
  .theme-task-preview-list {
    padding-block: 5px;
  }
</style>
