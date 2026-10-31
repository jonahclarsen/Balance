<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import PlanItemEditor from './PlanItemEditor.svelte'
  import VoiceIdeaModal from './VoiceIdeaModal.svelte'
  import { plannerStore } from './store'
  import { focusTaskBelow } from './taskCompletionFocus'
  import { ideaUnlockDelay, findIdea, ideaGroupId, ideaGroupKindForKey, IDEA_GROUPS, IDEA_TRASH_RETENTION_DAYS } from './ideas'
  import type { ItemLink, ItemTimeWarning } from './planner'
  import { clipsByIdea, formatClipDuration } from './voiceClips'
  import { cancelVoiceRecording, startVoiceRecording, stopVoiceRecording, voiceRecording, voiceRecordingError } from './voiceRecorder'
  import { canTranscribe, transcribeClips, transcriptionError, transcriptionStatus } from './voiceTranscription'
  import type { Id, IdeaGroup, IdeaGroupKind, ListTemplate, Metric, Note, VoiceClip } from './types'

  export let groups: IdeaGroup[]
  export let voiceClips: VoiceClip[] = []
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let notes: Note[] = []
  export let mobile = false
  export let onOpenLink: (link: ItemLink, itemId: Id) => void = () => {}
  export let onImport: () => void
  export let onReview: () => void
  export let onSortPropositions: () => void
  export let onCopyItem: (groupId: Id, itemId: Id) => void = () => {}
  export let onCutItem: (groupId: Id, itemId: Id) => void = () => {}
  export let onPasteItem: (groupId: Id, itemId: Id) => void | Promise<void> = () => {}

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
  let openClipId: Id | null = null
  let now = Date.now()
  let clock: number | null = null

  $: selected = selectedItemId ? findIdea(groups, selectedItemId) : null
  $: clipForIdea = clipsByIdea(voiceClips)
  $: untranscribed = voiceClips.filter((clip) => !clip.transcript)
  $: openClip = openClipId ? voiceClips.find((clip) => clip.id === openClipId) ?? null : null
  $: openIdea = openClip ? findIdea(groups, openClip.ideaId) : null
  $: recording = $voiceRecording.state === 'recording' ? $voiceRecording : null
  $: syncClock(recording !== null)
  $: transcribing = $transcriptionStatus
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

  function syncClock(running: boolean) {
    if (running && clock === null) clock = window.setInterval(() => { now = Date.now() }, 250)
    else if (!running && clock !== null) {
      window.clearInterval(clock)
      clock = null
    }
    now = Date.now()
  }

  async function finishRecording() {
    const recorded = await stopVoiceRecording()
    if (recorded) plannerStore.addVoiceIdea(recorded)
  }

  function transcribe(clips: VoiceClip[]) {
    void transcribeClips(clips, plannerStore.applyVoiceTranscript)
  }

  function moveOpenIdea(kind: IdeaGroupKind) {
    if (openIdea) plannerStore.moveIdeaToGroup(openIdea.item.id, kind)
    openClipId = null
  }

  // Lines the chip up under its idea's text, whatever the row's controls.
  function alignWithText(node: HTMLElement) {
    const align = () => {
      const text = node.previousElementSibling?.querySelector('[data-plan-text-input]')
      const parent = node.parentElement
      if (text && parent) node.style.marginLeft = `${text.getBoundingClientRect().left - parent.getBoundingClientRect().left}px`
    }
    const observer = new ResizeObserver(align)
    if (node.parentElement) observer.observe(node.parentElement)
    align()
    return { destroy: () => observer.disconnect() }
  }

  async function addItem(groupId: Id) {
    const itemId = plannerStore.addRootIdeaItem(groupId)
    await tick()
    document.querySelector<HTMLDivElement>(
      `[data-plan-item-scope="${CSS.escape(groupId)}"] [data-plan-item-id="${CSS.escape(itemId)}"] [data-plan-text-focus-target]`,
    )?.focus()
  }

  onDestroy(() => {
    for (const timer of unlockTimers) window.clearTimeout(timer)
    if (shakeTimer !== null) window.clearTimeout(shakeTimer)
    if (clock !== null) window.clearInterval(clock)
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
          <div class="voice-idea-controls">
            {#if recording}
              <span class="voice-recording-dot" style:--level={recording.level} aria-hidden="true"></span>
              <span class="voice-recording-time">{formatClipDuration(now - recording.startedAt)}</span>
              <button class="ghost" type="button" aria-label="Discard recording" title="Discard" on:click={cancelVoiceRecording}>✕</button>
              <button class="voice-record-button recording" type="button" aria-label="Stop recording" title="Stop" on:click={() => { void finishRecording() }}>■</button>
            {:else}
              {#if canTranscribe && untranscribed.length > 0}
                <button class="ghost" type="button" disabled={transcribing.state !== 'idle'} on:click={() => transcribe(untranscribed)}>
                  {#if transcribing.state === 'downloading'}Downloading {Math.round(transcribing.fraction * 100)}%{:else if transcribing.state === 'transcribing'}Transcribing {transcribing.done + 1}/{transcribing.total}{:else if transcribing.state === 'preparing'}Transcribing…{:else}Transcribe {untranscribed.length}{/if}
                </button>
              {/if}
              <button
                class="voice-record-button"
                type="button"
                aria-label="Record an idea"
                title="Record"
                disabled={$voiceRecording.state !== 'idle'}
                on:click={() => { void startVoiceRecording() }}
              >●</button>
            {/if}
          </div>
          <button class="ghost idea-group-review-button" type="button" disabled={group.items.length === 0} on:click={onSortPropositions}>Sort</button>
        {:else if meta.kind === 'genuine'}
          <button class="ghost idea-group-review-button" type="button" on:click={onReview}>Review</button>
        {:else if meta.kind === 'trash'}
          <span class="idea-group-note">clears after {IDEA_TRASH_RETENTION_DAYS} days</span>
        {/if}
      </header>
      {#if meta.kind === 'proposition' && ($voiceRecordingError || $transcriptionError)}
        <p class="voice-idea-error" role="alert">{$voiceRecordingError ?? $transcriptionError}</p>
      {/if}
      {#if meta.kind !== 'trash' || trashOpen}
        <div class="list-panel idea-group-list" data-plan-item-scope={group.id}>
          {#each group.items as item (item.id)}
            {@const clip = clipForIdea.get(item.id)}
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
              {onCopyItem}
              {onCutItem}
              {onPasteItem}
              hideTime
              collapsible
              placeholder={clip ? 'Voice idea' : undefined}
            />
            {#if clip}
              <button
                use:alignWithText
                type="button"
                class="voice-clip-chip"
                data-voice-clip={clip.id}
                aria-label={`Voice idea, ${formatClipDuration(clip.durationMs)}`}
                on:click={() => { openClipId = clip.id }}
              >
                <svg viewBox={`0 0 ${Math.min(48, clip.peaks.length)} 16`} preserveAspectRatio="none" aria-hidden="true">
                  {#each Array.from({ length: Math.min(48, clip.peaks.length) }, (_, index) => clip.peaks[Math.floor((index * clip.peaks.length) / Math.min(48, clip.peaks.length))] ?? 0) as peak, index}
                    <rect x={index + 0.15} width="0.7" y={8 - Math.max(0.6, (peak / 255) * 8)} height={Math.max(1.2, (peak / 255) * 16)} />
                  {/each}
                </svg>
                <span>{formatClipDuration(clip.durationMs)}</span>
              </button>
            {/if}
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

{#if openClip && openIdea}
  {#key openClip.id}
    <VoiceIdeaModal
      clip={openClip}
      idea={openIdea.item}
      onEdit={(text, html) => { if (openIdea) plannerStore.patchIdeaItem(openIdea.group.id, openIdea.item.id, { text, html }) }}
      onMove={moveOpenIdea}
      onTranscribe={() => { if (openClip) transcribe([openClip]) }}
      onClose={() => { openClipId = null }}
    />
  {/key}
{/if}

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
  .voice-idea-controls + .idea-group-review-button { margin-left: 0; }
  .voice-idea-controls {
    display: flex;
    align-items: center;
    gap: 6px;
    margin-left: auto;
  }
  .voice-idea-controls button { padding: 2px 8px; font-size: 13px; }
  .voice-record-button.voice-record-button {
    width: 26px;
    height: 26px;
    padding: 0;
    border-radius: 50%;
    color: var(--danger);
    font-size: 14px;
    line-height: 1;
  }
  .voice-record-button.recording { color: var(--ink); font-size: 11px; }
  .voice-recording-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--danger);
    box-shadow: 0 0 0 calc(var(--level, 0) * 7px) color-mix(in srgb, var(--danger) 30%, transparent);
    transition: box-shadow 80ms linear;
  }
  .voice-recording-time { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .voice-idea-error { margin: 2px 0 4px; color: var(--danger); font-size: 13px; }
  .voice-clip-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    margin: 0 0 6px;
    padding: 2px 8px;
    border-radius: 999px;
    color: var(--accent);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .voice-clip-chip svg { width: 56px; height: 14px; fill: currentColor; }
  .voice-clip-chip span { color: var(--muted); }
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
