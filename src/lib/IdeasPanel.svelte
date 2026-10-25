<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import PlanItemEditor from './PlanItemEditor.svelte'
  import { plannerStore } from './store'
  import { focusTaskBelow } from './taskCompletionFocus'
  import { ideaUnlockDelay, findIdea, ideaGroupId, ideaGroupKindForKey, IDEA_GROUPS, IDEA_TRASH_RETENTION_DAYS } from './ideas'
  import type { ItemLink, ItemTimeWarning } from './planner'
  import type { Id, IdeaGroup, IdeaGroupKind, ListTemplate, Metric, Note } from './types'

  export let groups: IdeaGroup[]
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
  let shaking: IdeaGroupKind | null = null
  let shakeTimer: number | null = null
  let trashOpen = false

  $: selected = selectedItemId ? findIdea(groups, selectedItemId) : null
  // Drop the selection once its idea disappears (undo, sync, purge).
  $: dropMissingSelection(groups)
  $: selectedItemIdSet = new Set(selectedItemId ? [selectedItemId] : [])
  // Missing groups render empty; the map keeps the template reactive to `groups`.
  $: groupsByKind = Object.fromEntries(IDEA_GROUPS.map((meta) => [
    meta.kind, groups.find((group) => group.kind === meta.kind) ?? { id: ideaGroupId(meta.kind), kind: meta.kind, items: [] },
  ])) as Record<IdeaGroupKind, IdeaGroup>

  function dropMissingSelection(current: IdeaGroup[]) {
    if (selectedItemId && !findIdea(current, selectedItemId)) selectedItemId = null
  }

  function select(itemId: Id | null) {
    selectedItemId = itemId
    selectedAt = Date.now()
    for (const timer of unlockTimers) window.clearTimeout(timer)
    unlockTimers = []
    const origin = itemId ? findIdea(groups, itemId)?.group.kind ?? null : null
    for (const target of IDEA_GROUPS) {
      const delay = ideaUnlockDelay(origin, target.kind)
      if (delay > 0) unlockTimers.push(window.setTimeout(() => { unlockTick += 1 }, delay))
    }
  }

  function locked(kind: IdeaGroupKind, _tick: number): boolean {
    return Date.now() < selectedAt + ideaUnlockDelay(selected?.group.kind ?? null, kind)
  }

  function handleSelectionPointerDown(itemId: Id, event: PointerEvent) {
    if (event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    select(selectedItemId === itemId ? null : itemId)
  }

  function shake(kind: IdeaGroupKind) {
    shaking = kind
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
    shakeTimer = window.setTimeout(() => { shaking = null }, 420)
  }

  function attemptMove(kind: IdeaGroupKind) {
    if (!selected || selected.group.kind === kind) return
    if (locked(kind, unlockTick)) {
      shake(kind)
      return
    }
    plannerStore.moveIdeaToGroup(selected.item.id, kind)
    select(null)
  }

  function rootIdsInOrder(): Id[] {
    return IDEA_GROUPS
      .filter((meta) => meta.kind !== 'trash' || trashOpen)
      .flatMap((meta) => groupsByKind[meta.kind].items.map((item) => item.id))
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

  // Cmd/Ctrl+D toggles done like on Today: the selected idea stays selected,
  // and completing the idea being edited moves the caret to the one below.
  function toggleDoneFromKeyboard(event: KeyboardEvent) {
    const active = document.activeElement
    const row = active instanceof Element ? active.closest<HTMLElement>('.ideas-panel [data-plan-item-id]') : null
    const target = selectedItemId ?? row?.dataset.planItemId
    const found = target ? findIdea(groups, target) : null
    if (!found) return
    event.preventDefault()
    if (event.repeat) return
    const done = !found.item.done
    plannerStore.patchIdeaItem(found.group.id, found.item.id, { done })
    if (done && !selectedItemId) void focusTaskBelow(found.group.id, [found.item.id])
  }

  function handleKeydown(event: KeyboardEvent) {
    if ((event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'd') {
      toggleDoneFromKeyboard(event)
      return
    }
    if (event.ctrlKey || event.altKey || event.repeat || editingText()) return
    // Backspace and Cmd+Backspace both delete a selected idea, to Trash unless it is already there.
    if (selected && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault()
      plannerStore.deleteIdeaItem(selected.group.id, selected.item.id)
      select(null)
      return
    }
    if (event.metaKey) return
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
    const kind = ideaGroupKindForKey(event.key)
    if (!kind) return
    event.preventDefault()
    event.stopPropagation()
    attemptMove(kind)
  }

  async function addItem(groupId: Id) {
    plannerStore.addRootIdeaItem(groupId)
    await tick()
    const input = Array.from(document.querySelectorAll<HTMLDivElement>(
      `[data-plan-item-scope="${CSS.escape(groupId)}"] [data-plan-text-focus-target]`,
    )).at(-1)
    input?.focus()
  }

  onDestroy(() => {
    for (const timer of unlockTimers) window.clearTimeout(timer)
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<section class="ideas-panel">
  <header class="page-header">
    <h2>Ideas</h2>
    <div class="template-panel-actions">
      <button type="button" on:click={onImport}>Import</button>
    </div>
  </header>

  {#each IDEA_GROUPS as meta (meta.kind)}
    {@const group = groupsByKind[meta.kind]}
    <section class="idea-group-card" data-idea-group={meta.kind} data-balance-link={`balance://idea-group/${meta.kind}`} aria-label={meta.label}>
      <header class="idea-group-card-header">
        {#if meta.kind === 'trash'}
          <h3><button class="idea-group-toggle" type="button" aria-expanded={trashOpen} on:click={() => { trashOpen = !trashOpen }}>{meta.label}</button></h3>
        {:else}
          <h3>{meta.label}</h3>
        {/if}
        <span class="idea-group-count">{group.items.length}</span>
        {#if meta.kind === 'proposition'}
          <button class="ghost idea-group-review-button" type="button" disabled={group.items.length === 0} on:click={onSortPropositions}>Sort</button>
        {:else if meta.kind === 'genuine'}
          <button class="ghost idea-group-review-button" type="button" on:click={onReview}>Review</button>
        {:else if meta.kind === 'trash'}
          <span class="idea-group-note">clears after {IDEA_TRASH_RETENTION_DAYS} days</span>
        {/if}
      </header>
      {#if meta.kind !== 'trash' || trashOpen}
        <div class="list-panel idea-group-list" data-plan-item-scope={group.id}>
          {#each group.items as item (item.id)}
            <PlanItemEditor
              {item}
              allItems={group.items}
              timeWarnings={noTimeWarnings}
              planId={group.id}
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
          <button class="add-row" type="button" on:click={() => { void addItem(group.id) }}>+ Add item</button>
        </div>
        {#if selected && selected.group.kind === meta.kind}
          <div class="idea-move-strip" role="group" aria-label="Move idea to">
            {#each IDEA_GROUPS.filter((target) => target.kind !== meta.kind) as target (target.kind)}
              <button
                type="button"
                class="idea-group-button"
                class:locked={locked(target.kind, unlockTick)}
                class:shaking={shaking === target.kind}
                aria-disabled={locked(target.kind, unlockTick) ? 'true' : undefined}
                on:click={() => attemptMove(target.kind)}
              >{target.label} <kbd aria-hidden="true">{target.key.toUpperCase()}</kbd></button>
            {/each}
          </div>
        {/if}
      {/if}
    </section>
  {/each}
</section>

<style>
  .ideas-panel { display: grid; gap: 12px; align-content: start; }
  .page-header h2 { margin: 0; }
  .idea-group-card {
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
    padding: 6px 10px 8px;
  }
  .idea-group-card-header {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-height: 28px;
  }
  .idea-group-card-header h3 { margin: 0; font-size: 15px; }
  .idea-group-toggle {
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    cursor: pointer;
  }
  .idea-group-toggle::after { content: ' ▸'; color: var(--muted); }
  .idea-group-toggle[aria-expanded='true']::after { content: ' ▾'; }
  .idea-group-count { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .idea-group-note { margin-left: auto; color: var(--muted); font-size: 12px; }
  .idea-group-review-button { margin-left: auto; padding: 2px 8px; font-size: 13px; }
  .idea-group-list { padding: 0; }
  .idea-move-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding: 6px 0 2px;
  }
  .idea-move-strip kbd {
    margin-left: 4px;
    font-size: 11px;
    opacity: 0.7;
  }
</style>
