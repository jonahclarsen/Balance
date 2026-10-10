<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import PlanItemEditor from './PlanItemEditor.svelte'
  import { plannerStore } from './store'
  import { bucketUnlockDelay, findIdea, ideaBucketId, ideaBucketKindForKey, IDEA_BUCKETS, IDEA_TRASH_RETENTION_DAYS } from './ideaBuckets'
  import type { ItemLink, ItemTimeWarning } from './planner'
  import type { Id, IdeaBucket, IdeaBucketKind, ListTemplate, Metric, Note } from './types'

  export let buckets: IdeaBucket[]
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let notes: Note[] = []
  export let mobile = false
  export let onOpenLink: (link: ItemLink, itemId: Id) => void = () => {}
  export let onImport: () => void
  export let onReview: () => void
  export let onSortPropositions: () => void

  const noTimeWarnings: ReadonlyMap<Id, ItemTimeWarning> = new Map()

  let selectedItemId: Id | null = null
  // Leaving Proposition Party unlocks each destination on its own delay,
  // counted from when the row was selected.
  let selectedAt = 0
  let unlockTimers: number[] = []
  let unlockTick = 0
  let shaking: IdeaBucketKind | null = null
  let shakeTimer: number | null = null

  $: selected = selectedItemId ? findIdea(buckets, selectedItemId) : null
  // Drop the selection once its idea disappears (undo, sync, purge).
  $: dropMissingSelection(buckets)
  $: selectedItemIdSet = new Set(selectedItemId ? [selectedItemId] : [])
  // Missing buckets render empty; the map keeps the template reactive to `buckets`.
  $: bucketsByKind = Object.fromEntries(IDEA_BUCKETS.map((meta) => [
    meta.kind, buckets.find((bucket) => bucket.kind === meta.kind) ?? { id: ideaBucketId(meta.kind), kind: meta.kind, items: [] },
  ])) as Record<IdeaBucketKind, IdeaBucket>

  function dropMissingSelection(current: IdeaBucket[]) {
    if (selectedItemId && !findIdea(current, selectedItemId)) selectedItemId = null
  }

  function select(itemId: Id | null) {
    selectedItemId = itemId
    selectedAt = Date.now()
    for (const timer of unlockTimers) window.clearTimeout(timer)
    unlockTimers = []
    const origin = itemId ? findIdea(buckets, itemId)?.bucket.kind ?? null : null
    for (const target of IDEA_BUCKETS) {
      const delay = bucketUnlockDelay(origin, target.kind)
      if (delay > 0) unlockTimers.push(window.setTimeout(() => { unlockTick += 1 }, delay))
    }
  }

  function locked(kind: IdeaBucketKind, _tick: number): boolean {
    return Date.now() < selectedAt + bucketUnlockDelay(selected?.bucket.kind ?? null, kind)
  }

  function handleSelectionPointerDown(itemId: Id, event: PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    select(selectedItemId === itemId ? null : itemId)
  }

  function shake(kind: IdeaBucketKind) {
    shaking = kind
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
    shakeTimer = window.setTimeout(() => { shaking = null }, 420)
  }

  function attemptMove(kind: IdeaBucketKind) {
    if (!selected || selected.bucket.kind === kind) return
    if (locked(kind, unlockTick)) {
      shake(kind)
      return
    }
    plannerStore.moveIdeaToBucket(selected.item.id, kind)
    select(null)
  }

  function rootIdsInOrder(): Id[] {
    return IDEA_BUCKETS.flatMap((meta) => bucketsByKind[meta.kind].items.map((item) => item.id))
  }

  function moveSelection(direction: -1 | 1) {
    const ids = rootIdsInOrder()
    if (ids.length === 0) return
    const index = selectedItemId ? ids.indexOf(selectedItemId) : -1
    const next = index === -1 ? (direction === 1 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, index + direction))
    select(ids[next]!)
  }

  function editingText(): boolean {
    const active = document.activeElement
    return active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, select'))
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat || editingText()) return
    if (event.key === 'Escape') {
      if (selectedItemId) {
        event.preventDefault()
        select(null)
      }
      return
    }
    if (!selected) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveSelection(event.key === 'ArrowDown' ? 1 : -1)
      return
    }
    const kind = ideaBucketKindForKey(event.key)
    if (!kind) return
    event.preventDefault()
    event.stopPropagation()
    attemptMove(kind)
  }

  async function addItem(bucketId: Id) {
    plannerStore.addRootIdeaItem(bucketId)
    await tick()
    const input = Array.from(document.querySelectorAll<HTMLDivElement>(
      `[data-plan-item-scope="${CSS.escape(bucketId)}"] [data-plan-text-focus-target]`,
    )).at(-1)
    input?.focus()
  }

  onDestroy(() => {
    for (const timer of unlockTimers) window.clearTimeout(timer)
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<section class="buckets-panel">
  <header class="page-header">
    <h2>Buckets</h2>
    <div class="template-panel-actions">
      <button type="button" on:click={onImport}>Import</button>
    </div>
  </header>

  {#each IDEA_BUCKETS as meta (meta.kind)}
    {@const bucket = bucketsByKind[meta.kind]}
    <section class="bucket-card" data-bucket={meta.kind} aria-label={meta.label}>
      <header class="bucket-card-header">
        <h3>{meta.label}</h3>
        <span class="bucket-count">{bucket.items.length}</span>
        {#if meta.kind === 'proposition'}
          <button class="ghost bucket-review-button" type="button" disabled={bucket.items.length === 0} on:click={onSortPropositions}>Sort</button>
        {:else if meta.kind === 'genuine'}
          <button class="ghost bucket-review-button" type="button" on:click={onReview}>Review</button>
        {:else if meta.kind === 'trash'}
          <span class="bucket-note">clears after {IDEA_TRASH_RETENTION_DAYS} days</span>
        {/if}
      </header>
      <div class="list-panel bucket-list" data-plan-item-scope={bucket.id}>
        {#each bucket.items as item (item.id)}
          <PlanItemEditor
            {item}
            allItems={bucket.items}
            timeWarnings={noTimeWarnings}
            planId={bucket.id}
            patchItem={plannerStore.patchIdeaItem}
            splitItem={plannerStore.splitIdeaItem}
            backspaceItemAtStart={plannerStore.backspaceIdeaItemAtStart}
            deleteItem={plannerStore.deleteIdeaItem}
            deleteItemPreservingChildren={plannerStore.deleteIdeaItemPreservingChildren}
            moveItem={plannerStore.moveIdeaItem}
            moveItemWithinLevel={plannerStore.moveIdeaItemWithinLevel}
            outdentItem={plannerStore.outdentIdeaItem}
            historyRevision={$plannerStore.historyRevision}
            selectedItemIds={selectedItemIdSet}
            onSelectionPointerDown={handleSelectionPointerDown}
            onMobileSelectionStart={(itemId) => select(itemId)}
            onMobileSelectionToggle={(itemId) => select(selectedItemId === itemId ? null : itemId)}
            {mobile}
            mobileSelectionMode={mobile && selectedItemId !== null}
            {listTemplates}
            {metrics}
            {notes}
            {onOpenLink}
            hideTime
            collapsible
          />
        {/each}
        <button class="add-row" type="button" on:click={() => { void addItem(bucket.id) }}>+ Add item</button>
      </div>
      {#if selected && selected.bucket.kind === meta.kind}
        <div class="bucket-move-strip" role="group" aria-label="Move idea to">
          {#each IDEA_BUCKETS.filter((target) => target.kind !== meta.kind) as target (target.kind)}
            <button
              type="button"
              class="idea-bucket-button"
              class:locked={locked(target.kind, unlockTick)}
              class:shaking={shaking === target.kind}
              aria-disabled={locked(target.kind, unlockTick) ? 'true' : undefined}
              on:click={() => attemptMove(target.kind)}
            >{target.label} <kbd aria-hidden="true">{target.key.toUpperCase()}</kbd></button>
          {/each}
        </div>
      {/if}
    </section>
  {/each}
</section>

<style>
  .buckets-panel { display: grid; gap: 12px; align-content: start; }
  .page-header h2 { margin: 0; }
  .bucket-card {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    padding: 6px 10px 8px;
  }
  .bucket-card-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-height: 28px;
  }
  .bucket-card-header h3 { margin: 0; font-size: 15px; }
  .bucket-count { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .bucket-note { margin-left: auto; color: var(--muted); font-size: 12px; }
  .bucket-review-button { margin-left: auto; padding: 2px 8px; font-size: 13px; }
  .bucket-list { padding: 0; }
  .bucket-move-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 0 2px;
  }
  .bucket-move-strip kbd {
    margin-left: 4px;
    font-size: 11px;
    opacity: 0.7;
  }
</style>
