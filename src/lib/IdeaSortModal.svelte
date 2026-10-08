<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import TaskCheckbox from './TaskCheckbox.svelte'
  import { bucketUnlockDelay, findIdea, ideaBucketMeta, IDEA_SORT_QUESTION } from './ideaBuckets'
  import { renderItemDisplayHTML } from './planner'
  import type { Id, IdeaBucket, IdeaBucketKind, IdeaItem } from './types'

  // Ideas are sorted one card at a time in their original order. Each card asks
  // the key question; Yes picks a keep bucket, No picks a discard bucket.
  export let queue: IdeaItem[]
  export let buckets: IdeaBucket[]
  // Review passes run the same cards over Genuinely Worth Doing without unlock delays.
  export const mode: 'proposition' | 'review' = 'proposition'
  export let title: string
  export let onDecide: (itemId: Id, kind: IdeaBucketKind) => void
  export let onAppendToPrevious: (itemId: Id, previousId: Id) => boolean
  export let onEdit: (itemId: Id, text: string) => void
  export let onToggleDone: (itemId: Id, done: boolean) => void
  export let onFinish: (completed: boolean) => void

  type Step = 'question' | 'yes' | 'no'

  let index = 0
  let step: Step = 'question'
  let editing = false
  let editDraft = ''
  let editInput: HTMLTextAreaElement | null = null
  let list: HTMLDivElement | null = null
  let decisions: Record<Id, IdeaBucketKind> = {}
  // Commitment buttons unlock on a delay measured from when the card appeared.
  let shownAt = Date.now()
  let unlockTimers: number[] = []
  let unlockTick = 0
  let shaking: IdeaBucketKind | null = null
  let shakeTimer: number | null = null

  $: ids = queue.map((item) => item.id)
  $: live = ids.map((id) => findIdea(buckets, id)?.item ?? queue.find((item) => item.id === id)!)
  $: current = live[index]
  $: from = current ? findIdea(buckets, current.id)?.bucket.kind ?? null : null
  $: options = step === 'yes' ? (['possible', 'genuine'] as const) : step === 'no' ? (['trash', 'afterlife'] as const) : []
  $: resetCard(index)

  function resetCard(_index: number) {
    step = 'question'
    editing = false
    shownAt = Date.now()
    scheduleUnlocks()
    void scrollCurrentIntoView()
  }

  function scheduleUnlocks() {
    for (const timer of unlockTimers) window.clearTimeout(timer)
    unlockTimers = []
    if (!current) return
    const origin = findIdea(buckets, current.id)?.bucket.kind ?? null
    for (const kind of ['trash', 'afterlife', 'possible', 'genuine'] as const) {
      const delay = bucketUnlockDelay(origin, kind)
      if (delay > 0) unlockTimers.push(window.setTimeout(() => { unlockTick += 1 }, delay))
    }
  }

  function locked(kind: IdeaBucketKind, _tick: number): boolean {
    return Date.now() < shownAt + bucketUnlockDelay(from, kind)
  }

  async function scrollCurrentIntoView() {
    await tick()
    const row = list?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!list || !row) return
    const listRect = list.getBoundingClientRect()
    const rowRect = row.getBoundingClientRect()
    const top = list.scrollTop + (rowRect.top - listRect.top - listRect.height * 0.3)
    list.scrollTo({ top: Math.max(0, top), behavior: 'smooth' })
  }

  function shake(kind: IdeaBucketKind) {
    shaking = kind
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
    shakeTimer = window.setTimeout(() => { shaking = null }, 420)
  }

  function choose(kind: IdeaBucketKind) {
    if (!current) return
    if (locked(kind, unlockTick)) {
      shake(kind)
      return
    }
    onDecide(current.id, kind)
    decisions = { ...decisions, [current.id]: kind }
    advance()
  }

  function advance() {
    if (index >= queue.length - 1) {
      onFinish(true)
      return
    }
    index += 1
  }

  function goBack() {
    if (index > 0) index -= 1
    else step = 'question'
  }

  function appendToPrevious() {
    if (!current || index === 0) return
    const previousId = queue[index - 1]!.id
    if (!onAppendToPrevious(current.id, previousId)) return
    queue = queue.filter((item) => item.id !== current.id)
    if (index >= queue.length) onFinish(true)
    else resetCard(index)
  }

  async function startEdit() {
    if (!current) return
    editDraft = current.text
    editing = true
    await tick()
    editInput?.focus()
    editInput?.select()
  }

  function saveEdit() {
    if (!current) return
    const text = editDraft.trim()
    if (text && text !== current.text) onEdit(current.id, text)
    editing = false
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return
    if (editing) {
      if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault()
        saveEdit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        editing = false
      }
      return
    }
    const key = event.key.toLowerCase()
    let handled = true
    if (event.key === 'Escape') onFinish(false)
    else if (key === 'b' || event.key === 'ArrowLeft') goBack()
    else if (key === 'e') void startEdit()
    else if (key === 'm') appendToPrevious()
    else if (step === 'question' && key === 'y') step = 'yes'
    else if (step === 'question' && key === 'n') step = 'no'
    else if (step === 'yes' && key === 'g') choose('genuine')
    else if (step === 'yes' && key === 'p') choose('possible')
    else if (step === 'no' && key === 'a') choose('afterlife')
    else if (step === 'no' && key === 't') choose('trash')
    else handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  function tagFor(item: IdeaItem): string | null {
    const kind = decisions[item.id]
    if (!kind) return null
    return ideaBucketMeta(kind).label
  }

  onDestroy(() => {
    for (const timer of unlockTimers) window.clearTimeout(timer)
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- Shares the paste-review layout so card sorting looks the same everywhere. -->
<div class="paste-review-backdrop idea-sort-backdrop">
  <div class="paste-review idea-sort" role="dialog" aria-modal="true" aria-labelledby="idea-sort-title">
    <div class="paste-review-head">
      <div>
        <p class="eyebrow">{title}</p>
        <h2 id="idea-sort-title">Idea {Math.min(index + 1, queue.length)} of {queue.length}</h2>
      </div>
      <button class="ghost" type="button" title="Close (Esc)" aria-label="Close" on:click={() => onFinish(false)}>✕</button>
    </div>

    <div class="paste-review-list" aria-label="Ideas being sorted" bind:this={list}>
      {#each live as item, itemIndex (item.id)}
        {@const isCurrent = itemIndex === index}
        {@const tag = tagFor(item)}
        <div
          class="paste-review-card paste-review-item idea-sort-card"
          class:current={isCurrent}
          class:kept={!isCurrent && Boolean(tag)}
          class:done={item.done}
          aria-current={isCurrent ? 'true' : undefined}
          data-idea-id={item.id}
        >
          {#if isCurrent && editing}
            <textarea
              class="paste-review-edit"
              rows="1"
              bind:value={editDraft}
              bind:this={editInput}
              placeholder="Idea text"
              aria-label="Edit idea"
            ></textarea>
          {:else}
            <div class="paste-review-line">
              <TaskCheckbox
                checked={item.done}
                disabled={!isCurrent}
                onChange={(event) => onToggleDone(item.id, event.currentTarget.checked)}
              />
              <div
                class="paste-review-text item-text item-text-display"
                class:done={item.done}
                class:empty={!item.text?.trim()}
              >{@html item.text?.trim() ? renderItemDisplayHTML(item.html, item.text, []) : '(empty idea)'}</div>
              {#if tag}<span class="idea-sort-tag">{tag}</span>{/if}
            </div>
            {#if item.children.length > 0}
              <ul class="idea-sort-children">
                {#each item.children as child (child.id)}<li>{child.text}</li>{/each}
              </ul>
            {/if}
          {/if}
        </div>
      {/each}
    </div>

    <p class="idea-sort-question">{IDEA_SORT_QUESTION}</p>

    <div class="paste-review-actions idea-sort-actions">
      {#if editing}
        <button class="primary" type="button" on:click={saveEdit}>Save (Enter)</button>
        <button type="button" on:click={() => (editing = false)}>Cancel (Esc)</button>
      {:else if step === 'question'}
        <button type="button" on:click={() => (step = 'no')}>No (N)</button>
        <button class="primary" type="button" on:click={() => (step = 'yes')}>Yes (Y)</button>
      {:else}
        {#each options as kind (kind)}
          {@const meta = ideaBucketMeta(kind)}
          <button
            type="button"
            class="idea-bucket-button"
            class:primary={kind === 'genuine' || kind === 'afterlife'}
            class:locked={locked(kind, unlockTick)}
            class:shaking={shaking === kind}
            aria-disabled={locked(kind, unlockTick) ? 'true' : undefined}
            on:click={() => choose(kind)}
          >{meta.label} ({meta.key.toUpperCase()})</button>
        {/each}
      {/if}
    </div>

    {#if !editing}
      <div class="paste-review-actions idea-sort-secondary">
        <button type="button" disabled={index === 0 && step === 'question'} on:click={goBack}>Back (B)</button>
        <button type="button" disabled={index === 0} title="Join this idea onto the previous one" on:click={appendToPrevious}>Append to previous (M)</button>
        <button type="button" on:click={() => void startEdit()}>Edit (E)</button>
      </div>
    {/if}

    <p class="paste-review-hint">{Object.keys(decisions).length}/{queue.length} sorted</p>
  </div>
</div>
