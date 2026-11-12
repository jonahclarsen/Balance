<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import ProgressBar from './ProgressBar.svelte'
  import TaskCheckbox from './TaskCheckbox.svelte'
  import OverlayModal from './OverlayModal.svelte'
  import RichTextEditor from './RichTextEditor.svelte'
  import VoiceClipChip from './VoiceClipChip.svelte'
  import VoiceIdeaModal from './VoiceIdeaModal.svelte'
  import IdeaRefinement from './IdeaRefinement.svelte'
  import { IDEA_GROUPS, IDEA_UNLOCK_MS, findIdea, ideaGroupMeta, IDEA_SORT_QUESTION } from './ideas'
  import { renderItemDisplayHTML, type ItemLink, type ItemTextSegment } from './planner'
  import { openClickedLink, openRenderedLinkFromShortcut } from './externalLinks'
  import type { Id, IdeaGroup, IdeaGroupKind, IdeaItem, IdeaSnapshot, PlanItem, VoiceClip } from './types'

  // Ideas are sorted one card at a time in queue order (bottom of the list first). Each card asks
  // the key question; Yes picks a keep group, No picks a discard group.
  export let queue: IdeaItem[]
  export let groups: IdeaGroup[]
  export let title: string
  // Ideas an earlier pass already sorted, so progress continues across passes.
  export let sortedBefore = 0
  export let linkSegments: (text: string) => ItemTextSegment[]
  export let onOpenLink: (link: ItemLink) => void
  // Hidden while another page is open; the sort resumes where it left off.
  export let active = true
  export let onDecide: (itemId: Id, kind: IdeaGroupKind) => void
  export let onAppendToPrevious: (itemId: Id, previousId: Id) => boolean
  export let onEdit: (itemId: Id, html: string, text: string) => void
  // Recordings show on their card as on the Ideas page and open the same dialog.
  export let voiceClips: VoiceClip[] = []
  export let onTranscribe: (clip: VoiceClip) => void = () => {}
  // Toggles the idea or one of its children, found under the idea being sorted.
  export let onToggleDone: (ideaId: Id, itemId: Id, done: boolean) => void
  // Removes the idea and puts it on the clipboard to paste where it belongs.
  export let onCut: (itemId: Id) => void
  export let onAddToNote: (itemId: Id) => Id | null
  // Only offered while generating a day: the idea joins that day's tasks.
  export let onAddToDay: ((itemId: Id) => void) | undefined = undefined
  // Back puts the ideas a decision touched back where they were and removes
  // the note an Add to new note created.
  export let onRestore: (snapshots: IdeaSnapshot[], noteId: Id | null) => void
  export let onFinish: (completed: boolean) => void
  // Scheduled reviews open on a summary page before the first card.
  export let intro: { days: number } | undefined = undefined
  // Pasted items must be read: Yes and No answer at once, but every choice
  // after them stays locked until the card has been up this long.
  export let readDelayMs = 0

  type Step = 'question' | 'yes' | 'no'

  let index = 0
  let introOpen = Boolean(intro)
  let step: Step = 'question'
  let editing = false
  let editHTML = ''
  let editText = ''
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
  let reading = false
  let readTimer: number | null = null
  type Action = IdeaGroupKind | 'note' | 'cut' | 'day'
  let shaking: Action | null = null
  let shakeTimer: number | null = null
  let openClipId: Id | null = null
  let refinement: { source: HTMLElement | null; sourceRect: DOMRect | null; text: string; destination: IdeaGroupKind; label: string; progress: number; distribution: number[]; serial: number } | null = null
  let refinementTimer: number | null = null
  let refinementSerial = 0
  let finishing = false

  $: sorted = sortedBefore + history.length
  $: queued = queue[index]
  $: current = queued ? findIdea(groups, queued.id)?.item ?? queued : undefined
  $: clip = current ? voiceClips.find((candidate) => candidate.ideaId === current.id) : undefined
  // Until its transcript arrives the audio is the whole idea, and it only
  // survives in an idea group, so choices that leave the groups wait.
  $: untranscribed = Boolean(clip && !clip.transcript)
  $: openClip = openClipId ? voiceClips.find((candidate) => candidate.id === openClipId) ?? null : null
  $: options = step === 'yes' ? (['possible', 'genuine'] as const) : step === 'no' ? (['trash', 'afterlife'] as const) : []
  $: resetCard(index)
  // Switching pages should never leave an unseen animation holding generation.
  $: if (!active && refinement) endRefinement()

  function endRefinement() {
    if (refinementTimer !== null) window.clearTimeout(refinementTimer)
    refinementTimer = null
    refinement = null
    if (finishing) {
      finishing = false
      onFinish(true)
    }
  }

  function refine(destination: IdeaGroupKind, label = ideaGroupMeta(destination).label) {
    if (!current || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return
    endRefinement()
    const kinds = IDEA_GROUPS.map(({ kind }) => kind)
    const counts = kinds.map((kind) => groups.find((group) => group.kind === kind)?.items.length ?? 0)
    const source = findIdea(groups, current.id)?.group.kind
    if (source) counts[kinds.indexOf(source)]! -= 1
    counts[kinds.indexOf(destination)]! += 1
    const count = Math.max(1, counts.reduce((sum, value) => sum + value, 0))
    const surface = document.querySelector<HTMLElement>('.idea-sort[role="dialog"]')
    refinement = {
      source: surface?.cloneNode(true) as HTMLElement ?? null, sourceRect: surface?.getBoundingClientRect() ?? null,
      text: current.text, destination, label, serial: ++refinementSerial,
      progress: (sortedBefore + history.length + 1) / total,
      distribution: counts.map((value) => value / count),
    }
    refinementTimer = window.setTimeout(endRefinement, 1320)
  }

  function finish() {
    if (refinement) {
      finishing = true
      // The last card also offers a real Back while its flourish is running.
      step = 'question'
    }
    else onFinish(true)
  }

  function renderIdeaHTML(item: PlanItem) {
    return renderItemDisplayHTML(item.html, item.text, linkSegments(item.text))
  }

  function resetCard(_index: number) {
    step = 'question'
    openClipId = null
    editing = false
    if (readTimer !== null) window.clearTimeout(readTimer)
    reading = readDelayMs > 0
    readTimer = reading ? window.setTimeout(() => { readTimer = null; reading = false }, readDelayMs) : null
  }

  function startSorting() {
    introOpen = false
  }

  function answer(next: 'yes' | 'no') {
    step = next
    answeredAt = Date.now()
    for (const timer of unlockTimers) window.clearTimeout(timer)
    unlockTimers = []
    for (const kind of ['trash', 'afterlife', 'possible', 'genuine'] as const) {
      const delay = IDEA_UNLOCK_MS[kind]
      if (delay > 0) unlockTimers.push(window.setTimeout(() => { unlockTick += 1 }, delay))
    }
  }

  function locked(action: Action, _tick: number, _reading: boolean): boolean {
    if (reading) return true
    return action in IDEA_UNLOCK_MS && Date.now() < answeredAt + IDEA_UNLOCK_MS[action as IdeaGroupKind]
  }

  // Shakes and refuses an action that is still locked.
  function refuse(action: Action): boolean {
    if (!locked(action, unlockTick, reading)) return false
    shake(action)
    return true
  }

  function shake(kind: Action) {
    shaking = kind
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
    shakeTimer = window.setTimeout(() => { shaking = null }, 420)
  }

  function snapshot(itemId: Id): IdeaSnapshot[] {
    const found = findIdea(groups, itemId)
    return found ? [{ kind: found.group.kind, index: found.index, item: found.item }] : []
  }

  function record(snapshots: IdeaSnapshot[], noteId: Id | null = null) {
    history = [...history, { index, queue, snapshots, noteId }]
  }

  function choose(kind: IdeaGroupKind) {
    if (!current || refuse(kind)) return
    refine(kind)
    record(snapshot(current.id))
    onDecide(current.id, kind)
    advance()
  }

  function advance() {
    if (index >= queue.length - 1) {
      finish()
      return
    }
    index += 1
  }

  function goBack() {
    finishing = false
    endRefinement()
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
    if (!current || index === 0 || untranscribed) return
    const previousId = queue[index - 1]!.id
    const snapshots = [...snapshot(previousId), ...snapshot(current.id)]
    if (!onAppendToPrevious(current.id, previousId)) return
    refine(findIdea(groups, previousId)?.group.kind ?? 'proposition', 'Append to previous')
    record(snapshots)
    dropCurrent()
  }

  function cut() {
    if (!current || untranscribed || refuse('cut')) return
    refine('proposition', 'Clipboard')
    record(snapshot(current.id))
    onCut(current.id)
    dropCurrent()
  }

  function addToDay() {
    if (!current || !onAddToDay || untranscribed || refuse('day')) return
    refine('proposition', 'Today')
    record(snapshot(current.id))
    onAddToDay(current.id)
    dropCurrent()
  }

  function addToNote() {
    if (!current || untranscribed || refuse('note')) return
    const snapshots = snapshot(current.id)
    const noteId = onAddToNote(current.id)
    if (!noteId) return
    refine('proposition', 'New note')
    record(snapshots, noteId)
    dropCurrent()
  }

  function dropCurrent() {
    if (!current) return
    const removedId = current.id
    queue = queue.filter((item) => item.id !== removedId)
    if (index >= queue.length) finish()
    else resetCard(index)
  }

  async function startEdit() {
    if (!current) return
    editHTML = current.html ?? ''
    editText = current.text
    editing = true
    await tick()
    const input = document.querySelector<HTMLElement>('.idea-sort [data-rich-text-input]')
    if (!input) return
    input.focus()
    const range = document.createRange()
    range.selectNodeContents(input)
    range.collapse(false)
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }

  function saveEdit() {
    if (!current) return
    const text = editText.trim()
    // Blurring reports the rendered markup, which alone isn't an edit.
    const changed = text !== current.text || (editHTML !== (current.html ?? '') && editHTML !== renderIdeaHTML(current))
    if (text && changed) onEdit(current.id, editHTML, text)
    editing = false
  }

  // The window listener saves; this only stops the editor adding a paragraph.
  function handleEditKeydown(_editor: HTMLDivElement, event: KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) event.preventDefault()
  }

  // Some soft keyboards report Enter only as a paragraph insertion.
  function handleEditBeforeInput(_editor: HTMLDivElement, event: InputEvent) {
    if (event.inputType !== 'insertParagraph') return
    event.preventDefault()
    saveEdit()
  }

  function handleKeydown(event: KeyboardEvent) {
    // The Voice idea dialog owns the keyboard while it's open.
    if (!active || openClip || event.metaKey || event.ctrlKey || event.repeat) return
    if (introOpen) {
      if (event.altKey) return
      if (event.key === 'Enter') startSorting()
      else if (event.key === 'Escape') onFinish(false)
      else return
      event.preventDefault()
      event.stopPropagation()
      return
    }
    if (event.altKey) {
      if (!event.shiftKey && event.code === 'KeyF' && !editing && current &&
          openRenderedLinkFromShortcut(renderIdeaHTML(current), onOpenLink)) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (editing) {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault()
        saveEdit()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        editing = false
      }
      return
    }
    const key = event.key.toLowerCase()
    const sortKey = ['b', 'e', 'm', 'y', 'n', 'g', 'p', 'x', 'd', 'a', 't'].includes(key) || event.key === 'ArrowLeft'
    // A deliberate next shortcut can cut the flourish short. Repeated keydown
    // is already ignored above, and pointer controls wait for the reveal.
    if (finishing && event.key !== 'Escape' && key !== 'b' && event.key !== 'ArrowLeft') {
      if (sortKey) {
        event.preventDefault()
        event.stopPropagation()
      }
      return
    }
    if (sortKey) {
      finishing = false
      endRefinement()
    }
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
    if (refinementTimer !== null) window.clearTimeout(refinementTimer)
    for (const timer of unlockTimers) window.clearTimeout(timer)
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
    if (readTimer !== null) window.clearTimeout(readTimer)
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<!-- Children read as the idea's own checklist: the same checkbox and text as
     the idea, smaller, hanging under its text on a tree guide. -->
{#snippet childRows(ideaId: Id, items: PlanItem[])}
  <ul class="idea-sort-children">
    {#each items as child (child.id)}
      <li>
        <div class="idea-sort-child">
          <TaskCheckbox
            checked={child.done}
            onChange={(event) => onToggleDone(ideaId, child.id, event.currentTarget.checked)}
          />
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
          <div
            on:click={(event) => openClickedLink(event, onOpenLink)}
            class="item-text item-text-display idea-sort-child-text"
            class:done={child.done}
          >{@html renderIdeaHTML(child)}</div>
        </div>
        {#if child.children.length > 0}{@render childRows(ideaId, child.children)}{/if}
      </li>
    {/each}
  </ul>
{/snippet}

<!-- Shares the paste-review layout so card sorting looks the same everywhere.
     Sits inside .content-shell so the sidebar stays usable. -->
<OverlayModal
  {active}
  {title}
  class="idea-sort"
  z={65}
  maxWidth={760}
  height={intro && introOpen ? null : 640}
  fill
  closeOnEscape={false}
  onClose={() => onFinish(false)}
>
  {#if intro && introOpen}
    <div class="idea-sort-intro">
      <strong>{queue.length} {queue.length === 1 ? 'idea' : 'ideas'}</strong>
      <span>Every {intro.days} days</span>
      <button class="primary" type="button" on:click={startSorting}>Start (Enter)</button>
    </div>
  {:else}
  <div class="idea-sort-stage" class:refining={Boolean(refinement)}>
  <span class="sort-announcement" role="status">{refinement ? `Sorted: ${refinement.label}` : ''}</span>
  <div class="paste-review" inert={Boolean(refinement)}>
    <ProgressBar done={sorted} {total} label="Ideas sorted" />
    <p class="idea-sort-question">{IDEA_SORT_QUESTION}</p>
    <div class="paste-review-list" aria-label="Idea being sorted">
      {#if current}
        {#key current.id}
          <div
            class="paste-review-card paste-review-item idea-sort-card current"
            class:done={current.done}
            data-idea-id={current.id}
          >
            <div class="paste-review-line">
              <TaskCheckbox
                checked={current.done}
                onChange={(event) => onToggleDone(current.id, current.id, event.currentTarget.checked)}
              />
              {#if editing}
                <RichTextEditor
                  className="paste-review-text item-text"
                  kind="idea"
                  inputId={current.id}
                  html={editHTML}
                  text={editText}
                  done={current.done}
                  placeholder="Idea text"
                  ariaLabel="Edit idea"
                  internalLinkSegments={linkSegments(editText)}
                  onChange={(html, text) => {
                    editHTML = html
                    editText = text
                  }}
                  onKeyDown={handleEditKeydown}
                  onBeforeInput={handleEditBeforeInput}
                  onInternalLinkClick={(link) => onOpenLink(link)}
                />
              {:else}
                <!-- Delegates clicks from native, keyboard-accessible anchors in the rendered HTML. -->
                <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
                <div
                  on:click={(event) => openClickedLink(event, onOpenLink)}
                  class="paste-review-text item-text item-text-display"
                  class:done={current.done}
                  class:empty={!current.text?.trim() && !clip}
                >{@html current.text?.trim() ? renderIdeaHTML(current) : clip ? '' : '(empty idea)'}</div>
              {/if}
              {#if clip}
                <VoiceClipChip {clip} onOpen={() => { openClipId = clip.id }} />
              {/if}
            </div>
            {#if current.children.length > 0}{@render childRows(current.id, current.children)}{/if}
          </div>
        {/key}
      {/if}
    </div>

    <div class="paste-review-actions idea-sort-actions">
      {#if editing}
        <button class="primary" type="button" on:click={saveEdit}>Save (Enter)</button>
        <button type="button" on:click={() => (editing = false)}>Cancel (Esc)</button>
      {:else if step === 'question'}
        <button type="button" on:click={() => answer('no')}>No (N)</button>
        <button class="primary" type="button" on:click={() => answer('yes')}>Yes (Y)</button>
      {:else}
        {#each options as kind (kind)}
          {@const meta = ideaGroupMeta(kind)}
          <button
            type="button"
            class="idea-group-button"
            class:primary={kind === 'afterlife'}
            class:locked={locked(kind, unlockTick, reading)}
            class:shaking={shaking === kind}
            aria-disabled={locked(kind, unlockTick, reading) ? 'true' : undefined}
            on:click={() => choose(kind)}
          >{meta.label} ({meta.key.toUpperCase()})</button>
        {/each}
        {#if step === 'yes' && !untranscribed}
          {#snippet extra(action: Action, title: string, label: string, run: () => void)}
            <button
              type="button"
              class="idea-group-button"
              class:locked={locked(action, unlockTick, reading)}
              class:shaking={shaking === action}
              aria-disabled={locked(action, unlockTick, reading) ? 'true' : undefined}
              {title}
              on:click={run}
            >{label}</button>
          {/snippet}
          {@render extra('note', 'Move this idea into a new note', 'Add to new note (N)', addToNote)}
          {@render extra('cut', 'Remove this idea and copy it to paste somewhere else', 'Cut (X)', cut)}
          {#if onAddToDay}
            {@render extra('day', 'Add this idea to the day being generated', 'Add to day (D)', addToDay)}
          {/if}
        {/if}
      {/if}
    </div>

    {#if !editing}
      <div class="paste-review-actions idea-sort-secondary">
        <button type="button" disabled={history.length === 0 && step === 'question'} on:click={goBack}>Back (B)</button>
        <button type="button" disabled={index === 0 || untranscribed} title="Join this idea onto the previous one" on:click={appendToPrevious}>Append to previous (M)</button>
        <button type="button" on:click={() => void startEdit()}>Edit (E)</button>
      </div>
    {/if}

    <p class="paste-review-hint">{sorted}/{total} sorted</p>
  </div>
  {#if refinement}
    {#key refinement.serial}
      <IdeaRefinement {...refinement} />
    {/key}
  {/if}
  </div>
  {/if}
</OverlayModal>

{#if active && openClip && current}
  {#key openClip.id}
    <VoiceIdeaModal
      clip={openClip}
      idea={current}
      onEdit={(text, html) => { if (current) onEdit(current.id, html, text) }}
      onTranscribe={() => { if (openClip) onTranscribe(openClip) }}
      onClose={() => { openClipId = null }}
    />
  {/key}
{/if}

<style>
  .idea-sort-stage {
    position: relative;
    display: flex;
    flex-direction: column;
  }
  .paste-review { flex: 1; min-height: 0; }
  .refining > .paste-review { pointer-events: none; }
  .sort-announcement {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>
