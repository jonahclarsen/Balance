<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import ProgressBar from './ProgressBar.svelte'
  import TaskCheckbox from './TaskCheckbox.svelte'
  import OverlayModal from './OverlayModal.svelte'
  import RichTextEditor from './RichTextEditor.svelte'
  import VoiceClipChip from './VoiceClipChip.svelte'
  import VoiceIdeaModal from './VoiceIdeaModal.svelte'
  import { IDEA_UNLOCK_MS, findIdea, ideaGroupMeta, IDEA_SORT_QUESTION } from './ideas'
  import { renderItemDisplayHTML, type ItemLink, type ItemTextSegment } from './planner'
  import { openClickedLink, openRenderedLinkFromShortcut } from './externalLinks'
  import type { AudioAsset, Id, IdeaGroup, IdeaGroupKind, IdeaItem, IdeaSnapshot, PlanItem, VoiceClip } from './types'
  import { noteAudioFromClip } from './noteAudio'

  // Ideas are sorted one card at a time in queue order (bottom of the list first). Each card asks
  // the key question; Yes picks a keep group, No picks a discard group.
  export let queue: IdeaItem[]
  export let groups: IdeaGroup[]
  export let title: string
  // Ideas an earlier pass already sorted, so progress continues across passes.
  export let sortedBefore = 0
  export let linkSegments: (text: string) => ItemTextSegment[]
  export let onOpenLink: (link: ItemLink) => void
  // Shows the idea on the Ideas page; the sort waits there for the return.
  export let onView: (itemId: Id) => void
  // Hidden while another page is open; the sort resumes where it left off.
  export let active = true
  // Add idea, Search or the shortcuts list is open on top and owns the keyboard.
  export let suspended = false
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
  // With audio, the idea's recording goes into the note as well.
  export let onAddToNote: (itemId: Id, audio?: AudioAsset) => Id | null
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

  // 'audio' asks whether Add to new note brings the idea's recording along.
  type Step = 'question' | 'yes' | 'no' | 'audio'

  let index = 0
  let introOpen = Boolean(intro)
  let step: Step = 'question'
  // The note's 64 kbps copy, encoded while the audio question is up.
  let noteAudio: { clipId: Id; asset: Promise<AudioAsset> } | null = null
  let audioBusy = false
  let audioError = ''
  let editing = false
  let editHTML = ''
  let editText = ''
  // Every way an idea leaves the queue counts as sorted, so the total stays
  // fixed and progress only moves forward until Back undoes a decision.
  let total = sortedBefore + queue.length
  // Ideas added while sorting, which join the end of the queue and stay there through Back.
  let appended: IdeaItem[] = []
  // Each decision records where its ideas were, so Back can undo it instead of
  // leaving the idea in both its old and new place.
  type Undo = { index: number; queue: IdeaItem[]; snapshots: IdeaSnapshot[]; noteId: Id | null }
  let history: Undo[] = []
  // Commitment buttons unlock on a delay measured from the Yes or No answer, in
  // every sort including Genuinely Worth Doing reviews. Possibly and Genuinely
  // count their full delay from when the card appeared, and still take a third
  // of it after Yes.
  let shownAt = Date.now()
  let answeredAt = Date.now()
  let unlockTimers: number[] = []
  let unlockTick = 0
  let reading = false
  let readTimer: number | null = null
  type Action = IdeaGroupKind | 'note' | 'cut' | 'day'
  let shaking: Action | null = null
  let shakeTimer: number | null = null
  let openClipId: Id | null = null
  // The first card appears plainly; every later one warps in.
  let warpReady = false
  let warpFilter: SVGFilterElement

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

  export function append(item: IdeaItem) {
    if (queue.some(({ id }) => id === item.id)) return
    queue = [...queue, item]
    appended = [...appended, item]
    total += 1
  }

  // A brief trippy warp as the next card arrives: per-channel displacement
  // through animated noise, settling in 300-500 ms. Purely visual; the
  // decision has already saved and the next key works at once.
  function warpIn(card: HTMLElement) {
    if (!warpReady || !warpFilter || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      warpReady = true
      return
    }
    const duration = 300 + Math.random() * 200
    const turn = Math.random() < .5 ? -1 : 1
    const noise = warpFilter.querySelector('feTurbulence')!
    const maps = warpFilter.querySelectorAll('feDisplacementMap')
    const hue = warpFilter.querySelector('feColorMatrix[type="hueRotate"]')!
    noise.setAttribute('seed', String(Math.floor(Math.random() * 1000)))
    card.style.filter = 'url(#idea-sort-warp)'
    const motion = card.animate([
      { transform: `perspective(700px) rotateY(${turn * 28}deg) skewX(${turn * -16}deg) scale(.82, 1.12)`, opacity: .15 },
      { transform: `perspective(700px) rotateY(${turn * -7}deg) skewX(${turn * 5}deg) scale(1.04, .97)`, opacity: 1, offset: .55 },
      { transform: 'none', opacity: 1 },
    ], { duration, easing: 'cubic-bezier(.2, .7, .3, 1)' })
    const started = performance.now()
    let frame = 0
    const draw = (now: number) => {
      const t = Math.min(1, (now - started) / duration)
      const left = (1 - t) ** 2
      const wobble = 1 + .45 * Math.sin(t * Math.PI * 5)
      const strength = 90 * left * wobble
      noise.setAttribute('baseFrequency', `${.004 + .02 * left + .006 * Math.sin(t * 9)} ${.03 + .09 * left}`)
      maps[0]!.setAttribute('scale', String(strength))
      maps[1]!.setAttribute('scale', String(-strength * .7))
      maps[2]!.setAttribute('scale', String(strength * 1.5))
      hue.setAttribute('values', String(turn * 220 * left))
      if (t < 1) frame = requestAnimationFrame(draw)
      else stop()
    }
    const stop = () => {
      cancelAnimationFrame(frame)
      motion.cancel()
      card.style.filter = ''
    }
    frame = requestAnimationFrame(draw)
    return { destroy: stop }
  }

  function renderIdeaHTML(item: PlanItem) {
    return renderItemDisplayHTML(item.html, item.text, linkSegments(item.text))
  }

  function resetCard(_index: number) {
    step = 'question'
    noteAudio = null
    audioBusy = false
    audioError = ''
    shownAt = Date.now()
    openClipId = null
    editing = false
    if (readTimer !== null) window.clearTimeout(readTimer)
    reading = readDelayMs > 0
    readTimer = reading ? window.setTimeout(() => { readTimer = null; reading = false }, readDelayMs) : null
  }

  function startSorting() {
    introOpen = false
    shownAt = Date.now()
  }

  function answer(next: 'yes' | 'no') {
    step = next
    answeredAt = Date.now()
    for (const timer of unlockTimers) window.clearTimeout(timer)
    unlockTimers = []
    for (const kind of ['trash', 'afterlife', 'possible', 'genuine'] as const) {
      const delay = unlockAt(kind) - answeredAt
      if (delay > 0) unlockTimers.push(window.setTimeout(() => { unlockTick += 1 }, delay))
    }
  }

  function unlockAt(kind: IdeaGroupKind): number {
    const delay = IDEA_UNLOCK_MS[kind]
    if (kind !== 'possible' && kind !== 'genuine') return answeredAt + delay
    return Math.max(shownAt + delay, answeredAt + delay / 3)
  }

  function locked(action: Action, _tick: number, _reading: boolean): boolean {
    if (reading) return true
    return action in IDEA_UNLOCK_MS && Date.now() < unlockAt(action as IdeaGroupKind)
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
    if (step === 'audio') {
      if (!audioBusy) step = 'yes'
      return
    }
    if (step !== 'question') {
      step = 'question'
      return
    }
    const last = history.at(-1)
    if (!last) return
    history = history.slice(0, -1)
    onRestore(last.snapshots, last.noteId)
    queue = [...last.queue, ...appended.filter((item) => !last.queue.some(({ id }) => id === item.id))]
    index = last.index
    resetCard(index)
  }

  function appendToPrevious() {
    if (!current || index === 0 || untranscribed) return
    const previousId = queue[index - 1]!.id
    const snapshots = [...snapshot(previousId), ...snapshot(current.id)]
    if (!onAppendToPrevious(current.id, previousId)) return
    record(snapshots)
    dropCurrent()
  }

  function cut() {
    if (!current || untranscribed || refuse('cut')) return
    record(snapshot(current.id))
    onCut(current.id)
    dropCurrent()
  }

  function addToDay() {
    if (!current || !onAddToDay || untranscribed || refuse('day')) return
    record(snapshot(current.id))
    onAddToDay(current.id)
    dropCurrent()
  }

  function addToNote() {
    if (!current || untranscribed || refuse('note')) return
    if (clip) {
      step = 'audio'
      audioError = ''
      if (noteAudio?.clipId !== clip.id) {
        const asset = noteAudioFromClip(clip)
        asset.catch(() => {})
        noteAudio = { clipId: clip.id, asset }
      }
      return
    }
    moveToNote()
  }

  async function answerAudio(include: boolean) {
    if (!current || audioBusy) return
    if (!include || !noteAudio) {
      moveToNote()
      return
    }
    const ideaId = current.id
    audioBusy = true
    try {
      const asset = await noteAudio.asset
      if (current?.id === ideaId && step === 'audio') moveToNote(asset)
    } catch (error) {
      audioError = error instanceof Error ? error.message : String(error)
      noteAudio = null
    } finally {
      audioBusy = false
    }
  }

  function moveToNote(audio?: AudioAsset) {
    if (!current) return
    const snapshots = snapshot(current.id)
    const noteId = onAddToNote(current.id, audio)
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
    if (!active || suspended || openClip || event.metaKey || event.ctrlKey || event.repeat) return
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
    let handled = true
    if (event.key === 'Escape') onFinish(false)
    else if (key === 'b' || event.key === 'ArrowLeft') goBack()
    else if (key === 'e') void startEdit()
    else if (key === 'i' && current) onView(current.id)
    else if (key === 'm') appendToPrevious()
    else if (step === 'question' && key === 'y') answer('yes')
    else if (step === 'question' && key === 'n') answer('no')
    else if (step === 'yes' && key === 'g') choose('genuine')
    else if (step === 'yes' && key === 'p') choose('possible')
    else if (step === 'yes' && key === 'x') cut()
    else if (step === 'yes' && key === 'n') addToNote()
    else if (step === 'audio' && key === 'y') void answerAudio(true)
    else if (step === 'audio' && key === 'n') void answerAudio(false)
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
  <div class="paste-review">
    <ProgressBar done={sorted} {total} label="Ideas sorted" />
    <p class="idea-sort-question">{step === 'audio' ? 'Include the recording?' : IDEA_SORT_QUESTION}</p>
    <div class="paste-review-list" aria-label="Idea being sorted">
      {#if current}
        {#key current.id}
          <div
            use:warpIn
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
      {:else if step === 'audio'}
        <button type="button" disabled={audioBusy} on:click={() => void answerAudio(false)}>No (N)</button>
        <button class="primary" type="button" disabled={audioBusy} on:click={() => void answerAudio(true)}>{audioBusy ? 'Compressing…' : 'Yes (Y)'}</button>
        {#if audioError}<p class="idea-sort-audio-error" role="alert">{audioError}</p>{/if}
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
        <button type="button" disabled={!current} on:click={() => { if (current) onView(current.id) }}>View (I)</button>
      </div>
    {/if}

    <p class="paste-review-hint">{sorted}/{total} sorted</p>
  </div>
  {/if}
</OverlayModal>

<svg class="idea-sort-warp" aria-hidden="true" width="0" height="0">
  <filter id="idea-sort-warp" bind:this={warpFilter} x="-25%" y="-25%" width="150%" height="150%" color-interpolation-filters="sRGB">
    <feTurbulence type="fractalNoise" baseFrequency="0.01 0.05" numOctaves="2" result="noise" />
    <!-- Each colour channel is displaced by its own amount, then recombined. -->
    {#each ['1 0 0 0 0  0 0 0 0 0  0 0 0 0 0', '0 0 0 0 0  0 1 0 0 0  0 0 0 0 0', '0 0 0 0 0  0 0 0 0 0  0 0 1 0 0'] as channel, i (i)}
      <feDisplacementMap in="SourceGraphic" in2="noise" scale="0" xChannelSelector="R" yChannelSelector="G" />
      <feColorMatrix type="matrix" values={`${channel}  0 0 0 1 0`} result={`channel-${i}`} />
    {/each}
    <feBlend in="channel-0" in2="channel-1" mode="screen" result="red-green" />
    <feBlend in="red-green" in2="channel-2" mode="screen" />
    <feColorMatrix type="hueRotate" values="0" />
  </filter>
</svg>

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
  .idea-sort-audio-error { flex-basis: 100%; margin: 0; color: var(--danger); font-size: 13px; }
  .idea-sort-warp {
    position: absolute;
    width: 0;
    height: 0;
    overflow: hidden;
    pointer-events: none;
  }
</style>
