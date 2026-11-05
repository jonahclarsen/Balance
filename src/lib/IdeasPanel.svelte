<script lang="ts">
  import { onDestroy, tick } from 'svelte'
  import PlanItemEditor from './PlanItemEditor.svelte'
  import VoiceIdeaModal from './VoiceIdeaModal.svelte'
  import IdeaReviewCadence from './IdeaReviewCadence.svelte'
  import { plannerStore } from './store'
  import { focusTaskBelow } from './taskCompletionFocus'
  import { ideaUnlockDelay, findIdea, ideaGroupId, ideaGroupKindForKey, ideaGroupMeta, IDEA_GROUPS, IDEA_TRASH_RETENTION_DAYS, scheduledIdeaReviewDefault, type ScheduledIdeaReviewKind } from './ideas'
  import type { ItemLink, ItemTimeWarning } from './planner'
  import { clipsByIdea, formatClipDuration } from './voiceClips'
  import { canChooseVoiceMic, cancelVoiceRecording, chooseVoiceMic, finishVoiceRecording, startVoiceRecording, voiceMic, voiceRecording, voiceRecordingError } from './voiceRecorder'
  import { canTranscribe, transcribeClips, transcriptionError, transcriptionStatus } from './voiceTranscription'
  import type { Id, IdeaGroup, IdeaGroupKind, ListTemplate, Metric, Note, VoiceClip } from './types'

  export let groups: IdeaGroup[]
  export let voiceClips: VoiceClip[] = []
  export let listTemplates: ListTemplate[] = []
  export let metrics: Metric[] = []
  export let notes: Note[] = []
  export let mobile = false
  export let activeGroup: IdeaGroupKind = 'proposition'
  export let onSelectGroup: (kind: IdeaGroupKind) => void = () => {}
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
  // An idea stays selected only while its group is the one showing.
  $: if (selected && selected.group.kind !== activeGroup) select(null)
  $: selectedItemIdSet = new Set(selectedItemId ? [selectedItemId] : [])
  // Missing groups render empty; the map keeps the template reactive to `groups`.
  $: groupsByKind = Object.fromEntries(IDEA_GROUPS.map((meta) => [
    meta.kind, groups.find((group) => group.kind === meta.kind) ?? { id: ideaGroupId(meta.kind), kind: meta.kind, items: [] },
  ])) as Record<IdeaGroupKind, IdeaGroup>
  $: activeMeta = ideaGroupMeta(activeGroup)
  $: activeScheduled = scheduledKind(activeGroup)

  function scheduledKind(kind: IdeaGroupKind): ScheduledIdeaReviewKind | null {
    return scheduledIdeaReviewDefault(kind) === null ? null : kind as ScheduledIdeaReviewKind
  }
  $: activeItems = groupsByKind[activeGroup].items

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

  function moveSelection(direction: -1 | 1) {
    const ids = activeItems.map((item) => item.id)
    if (ids.length === 0) return
    const index = selectedItemId ? ids.indexOf(selectedItemId) : -1
    const next = index === -1 ? (direction === 1 ? 0 : ids.length - 1) : Math.min(ids.length - 1, Math.max(0, index + direction))
    select(ids[next]!)
  }

  function editingText(): boolean {
    const active = document.activeElement
    return active instanceof HTMLElement && (active.isContentEditable || active.matches('input, textarea, select'))
  }

  function focusedIdeaId(): Id | null {
    const active = document.activeElement
    const row = active instanceof Element ? active.closest<HTMLElement>('.ideas-panel [data-plan-item-id]') : null
    return row?.dataset.planItemId ?? null
  }

  // Cmd/Ctrl+Shift+A selects the idea being edited, like on Today.
  function selectFocusedIdea(event: KeyboardEvent) {
    const itemId = focusedIdeaId()
    if (!itemId) return
    event.preventDefault()
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur()
    select(itemId)
  }

  // Cmd/Ctrl+D toggles done like on Today: the selected idea stays selected,
  // and completing the idea being edited moves the caret to the one below.
  function toggleDoneFromKeyboard(event: KeyboardEvent) {
    const target = selectedItemId ?? focusedIdeaId()
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
    if ((event.metaKey || event.ctrlKey) && !event.altKey && event.shiftKey && event.key.toLowerCase() === 'a') {
      selectFocusedIdea(event)
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

  // A new recording lands in Proposition Party, so show it there.
  function startRecording() {
    onSelectGroup('proposition')
    void startVoiceRecording()
  }

  // The phone rail scrolls sideways; keep the open card on screen.
  function revealWhenActive(node: HTMLElement, active: boolean) {
    const reveal = (isActive: boolean) => {
      if (isActive && mobile) node.scrollIntoView({ block: 'nearest', inline: 'nearest' })
    }
    reveal(active)
    return { update: reveal }
  }

  function transcribe(clips: VoiceClip[]) {
    void transcribeClips(clips, plannerStore.applyVoiceTranscript)
  }

  function moveOpenIdea(kind: IdeaGroupKind) {
    if (openIdea) plannerStore.moveIdeaToGroup(openIdea.item.id, kind)
    openClipId = null
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
      {#if activeGroup === 'proposition'}
        <button type="button" disabled={activeItems.length === 0} on:click={onSortPropositions}>Sort</button>
      {:else if activeScheduled}
        {#if mobile}<IdeaReviewCadence kind={activeScheduled} {groups} label={activeMeta.label} />{/if}
        <button type="button" on:click={onReview}>Review</button>
      {:else if activeGroup === 'trash'}
        <span class="idea-group-note">clears after {IDEA_TRASH_RETENTION_DAYS} days</span>
      {/if}
      <div class="voice-idea-controls">
        {#if recording}
          <span class="voice-recording-dot" style:--level={recording.level} aria-hidden="true"></span>
          <span class="voice-recording-time">{formatClipDuration(now - recording.startedAt)}</span>
          <button class="ghost" type="button" aria-label="Discard recording" title="Discard" on:click={cancelVoiceRecording}>✕</button>
          <button class="voice-record-button recording" type="button" aria-label="Stop recording" title="Stop" on:click={() => { void finishVoiceRecording() }}>■</button>
        {:else}
          {#if canTranscribe && untranscribed.length > 0}
            <button class="ghost" type="button" disabled={transcribing.state !== 'idle'} on:click={() => transcribe(untranscribed)}>
              {#if transcribing.state === 'downloading'}Downloading {Math.round(transcribing.fraction * 100)}%{:else if transcribing.state === 'transcribing'}Transcribing {transcribing.done + 1}/{transcribing.total}{:else if transcribing.state === 'preparing'}Transcribing…{:else}Transcribe {untranscribed.length}{/if}
            </button>
          {/if}
          {#if canChooseVoiceMic()}
            <div class="voice-mic-choice">
              <button class="ghost" type="button" aria-label="Headset microphone" title="Headset" aria-pressed={$voiceMic === 'headset'} on:click={() => chooseVoiceMic('headset')}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zM17 14h3v6h-3z" /></svg>
              </button>
              <button class="ghost" type="button" aria-label="Phone microphone" title="Phone" aria-pressed={$voiceMic === 'phone'} on:click={() => chooseVoiceMic('phone')}>
                <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2" /></svg>
              </button>
            </div>
          {/if}
          <button
            class="voice-record-button"
            type="button"
            aria-label="Record an idea"
            title="Record"
            disabled={$voiceRecording.state !== 'idle'}
            on:click={startRecording}
          >●</button>
        {/if}
      </div>
      <button type="button" on:click={onImport}>Import</button>
    </div>
  </header>

  {#if $voiceRecordingError || $transcriptionError}
    <p class="voice-idea-error" role="alert">{$voiceRecordingError ?? $transcriptionError}</p>
  {/if}

  <div class="ideas-layout">
    <nav class="idea-group-cards" aria-label="Idea groups">
      {#each IDEA_GROUPS as meta (meta.kind)}
        {@const items = groupsByKind[meta.kind].items}
        {@const preview = items.find((item) => item.text.trim())?.text}
        {@const scheduled = mobile ? null : scheduledKind(meta.kind)}
        <div class="idea-group-slot">
        <button
          type="button"
          class="idea-group-card"
          class:scheduled
          class:active={meta.kind === activeGroup}
          aria-current={meta.kind === activeGroup ? 'true' : undefined}
          data-idea-group={meta.kind}
          data-balance-link={`balance://idea-group/${meta.kind}`}
          use:revealWhenActive={meta.kind === activeGroup}
          on:click={() => onSelectGroup(meta.kind)}
        >
          <strong>{meta.label}</strong>
          <span class="idea-group-count">{items.length}</span>
          {#if preview}<small>{preview}</small>{/if}
        </button>
        <!-- A sibling, since inputs can't sit inside the card button; it
             occupies the card's reserved bottom padding. -->
        {#if scheduled}
          <div class="idea-group-card-cadence"><IdeaReviewCadence kind={scheduled} {groups} label={meta.label} onTap={() => onSelectGroup(meta.kind)} /></div>
        {/if}
        </div>
      {/each}
    </nav>

    <section class="idea-group-pane" data-idea-pane={activeGroup} data-balance-link={`balance://idea-group/${activeGroup}`} aria-label={activeMeta.label}>
      <div class="list-panel idea-group-list" data-plan-item-scope={groupsByKind[activeGroup].id}>
        {#if activeGroup === 'proposition'}
          <button class="add-row add-row-top" type="button" on:click={() => { void addItem(groupsByKind[activeGroup].id) }}>+ Add item</button>
        {/if}
        {#each activeItems as item (item.id)}
          {@const clip = clipForIdea.get(item.id)}
          <PlanItemEditor
            {item}
            allItems={activeItems}
            timeWarnings={noTimeWarnings}
            planId={groupsByKind[activeGroup].id}
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
          >
            <svelte:fragment slot="trailing">
              {#if clip}
                <button
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
            </svelte:fragment>
          </PlanItemEditor>
        {/each}
        {#if activeGroup !== 'proposition'}
          <button class="add-row" type="button" on:click={() => { void addItem(groupsByKind[activeGroup].id) }}>+ Add item</button>
        {/if}
      </div>
      {#if selected}
        <div class="idea-move-strip" role="group" aria-label="Move idea to">
          {#each IDEA_GROUPS.filter((target) => target.kind !== activeGroup) as target (target.kind)}
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
    </section>
  </div>
</section>

{#if openClip && openIdea}
  {#key openClip.id}
    <VoiceIdeaModal
      clip={openClip}
      idea={openIdea.item}
      onEdit={(text, html) => { if (openIdea) plannerStore.patchIdeaItem(openIdea.group.id, openIdea.item.id, { text, html }) }}
      onMove={moveOpenIdea}
      onTranscribe={() => { if (openClip?.transcript) plannerStore.applyVoiceTranscript(openClip.id, openClip.transcript); else if (openClip) transcribe([openClip]) }}
      onClose={() => { openClipId = null }}
    />
  {/key}
{/if}

<style>
  .ideas-panel { display: grid; align-content: start; }
  .page-header h2 { margin: 0; }
  .add-row-top { margin: 0 0 12px; }
  .idea-group-list > .add-row:first-child:last-child { margin: 0; }
  .template-panel-actions { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .template-panel-actions button { font-size: 14px; padding: 6px 10px; }
  .ideas-layout {
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    gap: 16px;
    align-items: start;
  }
  .idea-group-cards {
    position: sticky;
    top: calc(var(--tree-sticky-base, 0px) + 12px);
    z-index: 1;
    display: grid;
    gap: 6px;
  }
  .idea-group-card {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 4px 8px;
    width: 100%;
    padding: 10px 11px;
    text-align: left;
  }
  .idea-group-slot { position: relative; }
  /* Reserves room for the cadence below the card's text, clear of its middle. */
  .idea-group-card.scheduled { padding-bottom: 38px; }
  .idea-group-card-cadence {
    position: absolute;
    left: 11px;
    bottom: 8px;
  }
  .idea-group-card:not(.active) {
    border-color: var(--line);
    background: var(--paper);
  }
  .idea-group-card:not(.active):hover { background: var(--paper-strong); }
  .idea-group-card strong { font-size: 14px; font-weight: 600; line-height: 1.35; }
  .idea-group-card small {
    grid-column: 1 / -1;
    overflow: hidden;
    color: var(--muted);
    font-size: 12px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .idea-group-count { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
  .idea-group-pane { min-width: 0; }
  .idea-group-note { color: var(--muted); font-size: 12px; }
  .voice-idea-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .voice-mic-choice { display: inline-flex; gap: 2px; }
  .voice-idea-controls .voice-mic-choice button { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; color: var(--muted); }
  .voice-idea-controls .voice-mic-choice button[aria-pressed='true'] { color: var(--ink); background: color-mix(in srgb, var(--ink) 12%, transparent); }
  .voice-mic-choice svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .voice-record-button.voice-record-button {
    width: 32px;
    height: 32px;
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
  .voice-idea-error { margin: 0 0 12px; color: var(--danger); font-size: 13px; }
  .voice-clip-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    padding: 2px 8px;
    border-radius: 999px;
    color: var(--accent);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .voice-clip-chip svg { width: 56px; height: 14px; fill: currentColor; }
  .voice-clip-chip span { color: var(--muted); }
  .idea-move-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    margin-top: 12px;
  }
  .idea-move-strip button { font-size: 14px; padding: 6px 10px; }
  .idea-move-strip kbd {
    margin-left: 4px;
    font-size: 11px;
    opacity: 0.7;
  }
  @media (max-width: 760px) {
    .ideas-layout { grid-template-columns: minmax(0, 1fr); gap: 12px; }
    /* The cards stay pinned as a sideways strip under the phone header. */
    .idea-group-cards {
      top: var(--tree-sticky-base, 0px);
      z-index: 10;
      display: flex;
      flex-wrap: nowrap;
      height: 56px;
      margin-inline: -12px;
      padding: 8px 12px;
      overflow-x: auto;
      /* Some themes use translucent paper; keep scrolled ideas from showing through. */
      background: var(--paper-strong);
      scrollbar-width: none;
    }
    .idea-group-slot { display: flex; flex: 0 0 auto; }
    .idea-group-card {
      flex: 0 0 auto;
      width: auto;
      align-items: center;
      padding-block: 0;
    }
    .idea-group-card small { display: none; }
    .idea-group-pane { --tree-sticky-base: calc(var(--mobile-header-height, 0px) + 56px); }
  }
</style>
