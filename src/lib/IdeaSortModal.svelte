<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import ProgressBar from './ProgressBar.svelte'
  import TaskCheckbox from './TaskCheckbox.svelte'
  import OverlayModal from './OverlayModal.svelte'
  import { BUCKET_UNLOCK_MS, findIdea, ideaBucketMeta, IDEA_SORT_QUESTION } from './ideaBuckets'
  import type { ItemLink } from './planner'
  import { openClickedLink, openRenderedLinkFromShortcut } from './externalLinks'
  import type { Id, IdeaBucket, IdeaBucketKind, IdeaItem, IdeaSnapshot } from './types'

  // Ideas are sorted one card at a time in their original order. Each card asks
  // the key question; Yes picks a keep bucket, No picks a discard bucket.
  export let queue: IdeaItem[]
  export let buckets: IdeaBucket[]
  export let title: string
  // Ideas an earlier pass already sorted, so progress continues across passes.
  export let sortedBefore = 0
  export let renderIdeaHTML: (item: IdeaItem) => string
  export let onOpenLink: (link: ItemLink) => void
  // Hidden while another page is open; the sort resumes where it left off.
  export let active = true
  export let onDecide: (itemId: Id, kind: IdeaBucketKind) => void
  export let onAppendToPrevious: (itemId: Id, previousId: Id) => boolean
  export let onEdit: (itemId: Id, text: string) => void
  export let onToggleDone: (itemId: Id, done: boolean) => void
  // Removes the idea and puts it on the clipboard to paste where it belongs.
  export let onCut: (itemId: Id) => void
  export let onAddToNote: (itemId: Id) => Id | null
  // Only offered while generating a day: the idea joins that day's tasks.
  export let onAddToDay: ((itemId: Id) => void) | undefined = undefined
  // Back puts the ideas a decision touched back where they were and removes
  // the note an Add to new note created.
  export let onRestore: (snapshots: IdeaSnapshot[], noteId: Id | null) => void
  export let onFinish: (completed: boolean) => void

  type Step = 'question' | 'yes' | 'no'

  let index = 0
  let step: Step = 'question'
  let editing = false
  let editDraft = ''
  let editInput: HTMLTextAreaElement | null = null
  // Every way an idea leaves the queue counts as sorted, so the total stays
  // fixed and progress only moves forward until Back undoes a decision.
  const total = sortedBefore + queue.length
  // Each decision records where its ideas were, so Back can undo it instead of
  // leaving the idea in both its old and new place.
  type Undo = { index: number; queue: IdeaItem[]; snapshots: IdeaSnapshot[]; noteId: Id | null }
  let history: Undo[] = []
  // Commitment buttons unlock on a delay measured from the Yes or No answer, in
  // every sort including Genuinely Worth Doing reviews.
  let answeredAt = Date.now()
  let unlockTimers: number[] = []
  let unlockTick = 0
  let shaking: IdeaBucketKind | null = null
  let shakeTimer: number | null = null

  $: sorted = sortedBefore + history.length
  $: queued = queue[index]
  $: current = queued ? findIdea(buckets, queued.id)?.item ?? queued : undefined
  $: options = step === 'yes' ? (['possible', 'genuine'] as const) : step === 'no' ? (['trash', 'afterlife'] as const) : []
  $: resetCard(index)

  function resetCard(_index: number) {
    step = 'question'
    editing = false
  }

  function answer(next: 'yes' | 'no') {
    step = next
    answeredAt = Date.now()
    for (const timer of unlockTimers) window.clearTimeout(timer)
    unlockTimers = []
    for (const kind of ['trash', 'afterlife', 'possible', 'genuine'] as const) {
      const delay = BUCKET_UNLOCK_MS[kind]
      if (delay > 0) unlockTimers.push(window.setTimeout(() => { unlockTick += 1 }, delay))
    }
  }

  function locked(kind: IdeaBucketKind, _tick: number): boolean {
    return Date.now() < answeredAt + BUCKET_UNLOCK_MS[kind]
  }

  function shake(kind: IdeaBucketKind) {
    shaking = kind
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
    shakeTimer = window.setTimeout(() => { shaking = null }, 420)
  }

  function snapshot(itemId: Id): IdeaSnapshot[] {
    const found = findIdea(buckets, itemId)
    return found ? [{ kind: found.bucket.kind, index: found.index, item: found.item }] : []
  }

  function record(snapshots: IdeaSnapshot[], noteId: Id | null = null) {
    history = [...history, { index, queue, snapshots, noteId }]
  }

  function choose(kind: IdeaBucketKind) {
    if (!current) return
    if (locked(kind, unlockTick)) {
      shake(kind)
      return
    }
    record(snapshot(current.id))
    onDecide(current.id, kind)
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
    if (step !== 'question') {
      step = 'question'
      return
    }
    const last = history.at(-1)
    if (!last) return
    history = history.slice(0, -1)
    onRestore(last.snapshots, last.noteId)
    queue = last.queue
    index = last.index
    resetCard(index)
  }

  function appendToPrevious() {
    if (!current || index === 0) return
    const previousId = queue[index - 1]!.id
    const snapshots = [...snapshot(previousId), ...snapshot(current.id)]
    if (!onAppendToPrevious(current.id, previousId)) return
    record(snapshots)
    dropCurrent()
  }

  function cut() {
    if (!current) return
    record(snapshot(current.id))
    onCut(current.id)
    dropCurrent()
  }

  function addToDay() {
    if (!current || !onAddToDay) return
    record(snapshot(current.id))
    onAddToDay(current.id)
    dropCurrent()
  }

  function addToNote() {
    if (!current) return
    const snapshots = snapshot(current.id)
    const noteId = onAddToNote(current.id)
    if (!noteId) return
    record(snapshots, noteId)
    dropCurrent()
  }

  function dropCurrent() {
    if (!current) return
    const removedId = current.id
    queue = queue.filter((item) => item.id !== removedId)
    if (index >= queue.length) onFinish(true)
    else resetCard(index)
  }

  async function startEdit() {
    if (!current) return
    editDraft = current.text
    editing = true
    await tick()
    editInput?.focus()
    editInput?.setSelectionRange(editDraft.length, editDraft.length)
  }

  function saveEdit() {
    if (!current) return
    const text = editDraft.trim()
    if (text && text !== current.text) onEdit(current.id, text)
    editing = false
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!active || event.metaKey || event.ctrlKey || event.repeat) return
    if (event.altKey) {
      if (!event.shiftKey && event.code === 'KeyF' && !editing && current &&
          openRenderedLinkFromShortcut(renderIdeaHTML(current), onOpenLink)) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
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
    else if (step === 'question' && key === 'y') answer('yes')
    else if (step === 'question' && key === 'n') answer('no')
    else if (step === 'yes' && key === 'g') choose('genuine')
    else if (step === 'yes' && key === 'p') choose('possible')
    else if (step === 'yes' && key === 'x') cut()
    else if (step === 'yes' && key === 'n') addToNote()
    else if (step === 'yes' && key === 'd' && onAddToDay) addToDay()
    else if (step === 'no' && key === 'a') choose('afterlife')
    else if (step === 'no' && key === 't') choose('trash')
    else handled = false
    if (handled) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  onDestroy(() => {
    for (const timer of unlockTimers) window.clearTimeout(timer)
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- Shares the paste-review layout so card sorting looks the same everywhere.
     Sits inside .content-shell so the sidebar stays usable. -->
<OverlayModal
  {active}
  {title}
  class="idea-sort"
  z={65}
  maxWidth={620}
  fill
  closeOnEscape={false}
  onClose={() => onFinish(false)}
>
  <div class="paste-review">
    <ProgressBar done={sorted} {total} label="Ideas sorted" />
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
                <!-- Delegates clicks from native, keyboard-accessible anchors in the rendered HTML. -->
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div
                  on:click={(event) => openClickedLink(event, onOpenLink)}
                  class="paste-review-text item-text item-text-display"
                  class:done={current.done}
                  class:empty={!current.text?.trim()}
                >{@html current.text?.trim() ? renderIdeaHTML(current) : '(empty idea)'}</div>
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
        <button type="button" on:click={() => answer('no')}>No (N)</button>
        <button class="primary" type="button" on:click={() => answer('yes')}>Yes (Y)</button>
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
        {#if step === 'yes'}
          <button type="button" title="Move this idea into a new note" on:click={addToNote}>Add to new note (N)</button>
          <button type="button" title="Remove this idea and copy it to paste somewhere else" on:click={cut}>Cut (X)</button>
          {#if onAddToDay}
            <button type="button" title="Add this idea to the day being generated" on:click={addToDay}>Add to day (D)</button>
          {/if}
        {/if}
      {/if}
    </div>

    {#if !editing}
      <div class="paste-review-actions idea-sort-secondary">
        <button type="button" disabled={history.length === 0 && step === 'question'} on:click={goBack}>Back (B)</button>
        <button type="button" disabled={index === 0} title="Join this idea onto the previous one" on:click={appendToPrevious}>Append to previous (M)</button>
        <button type="button" on:click={() => void startEdit()}>Edit (E)</button>
      </div>
    {/if}

    <p class="paste-review-hint">{sorted}/{total} sorted</p>
  </div>
</OverlayModal>
