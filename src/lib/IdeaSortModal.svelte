<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import ProgressBar from './ProgressBar.svelte'
  import TaskCheckbox from './TaskCheckbox.svelte'
  import { dismissOnBackdropClick } from './backdropDismiss'
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
  let decisions: Record<Id, IdeaBucketKind> = {}
  // Commitment buttons unlock on a delay measured from when the card appeared.
  let shownAt = Date.now()
  let unlockTimers: number[] = []
  let unlockTick = 0
  let shaking: IdeaBucketKind | null = null
  let shakeTimer: number | null = null

  $: queued = queue[index]
  $: current = queued ? findIdea(buckets, queued.id)?.item ?? queued : undefined
  $: from = current ? findIdea(buckets, current.id)?.bucket.kind ?? null : null
  $: options = step === 'yes' ? (['possible', 'genuine'] as const) : step === 'no' ? (['trash', 'afterlife'] as const) : []
  $: resetCard(index)

  function resetCard(_index: number) {
    step = 'question'
    editing = false
    shownAt = Date.now()
    scheduleUnlocks()
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

  $: tag = current && decisions[current.id] ? ideaBucketMeta(decisions[current.id]!).label : null

  onDestroy(() => {
    for (const timer of unlockTimers) window.clearTimeout(timer)
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- Shares the paste-review layout so card sorting looks the same everywhere. -->
<div class="paste-review-backdrop idea-sort-backdrop" use:dismissOnBackdropClick={() => onFinish(false)}>
  <div class="paste-review idea-sort" role="dialog" aria-modal="true" aria-labelledby="idea-sort-title">
    <div class="paste-review-head">
      <div class="idea-sort-head-main">
        <h2 class="eyebrow" id="idea-sort-title">{title}</h2>
        <ProgressBar done={index} total={queue.length} label="Ideas sorted" />
      </div>
      <button class="ghost" type="button" title="Close (Esc)" aria-label="Close" on:click={() => onFinish(false)}>✕</button>
    </div>

    <div class="paste-review-list" aria-label="Idea being sorted">
      {#if current}
        {#key current.id}
          <div
            class="paste-review-card paste-review-item idea-sort-card current"
            class:done={current.done}
            data-idea-id={current.id}
          >
            {#if editing}
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
                  checked={current.done}
                  onChange={(event) => onToggleDone(current.id, event.currentTarget.checked)}
                />
                <div
                  class="paste-review-text item-text item-text-display"
                  class:done={current.done}
                  class:empty={!current.text?.trim()}
                >{@html current.text?.trim() ? renderItemDisplayHTML(current.html, current.text, []) : '(empty idea)'}</div>
                {#if tag}<span class="idea-sort-tag">{tag}</span>{/if}
              </div>
              {#if current.children.length > 0}
                <ul class="idea-sort-children">
                  {#each current.children as child (child.id)}<li>{child.text}</li>{/each}
                </ul>
              {/if}
            {/if}
          </div>
        {/key}
      {/if}
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
