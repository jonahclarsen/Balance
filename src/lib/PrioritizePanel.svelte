<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import { plannerStore } from './store'
  import {
    PRIORITIZE_IDLE_MS,
    defaultPrioritySeeds,
    nextUnratedId,
    orderPriorityItems,
    prioritizeReveal,
    readOpenSession,
    writeOpenSession,
  } from './prioritize'
  import type { Goal, GoalCompletion, Id, PriorityItem, PrioritySession, Project, ProjectCheckIn } from './types'

  export let sessions: PrioritySession[] = []
  export let projects: Project[] = []
  export let checkIns: ProjectCheckIn[] = []
  export let goals: Goal[] = []
  export let goalCompletions: GoalCompletion[] = []
  export let currentDay: string

  let screen: 'home' | 'past' | 'session' = 'home'
  let sessionId: Id | null = null
  let selectedId: Id | null = null
  let addText = ''
  let numberDraft = ''
  let draftItemId: Id | null = null
  // The next digit replaces the shown value instead of appending to it.
  let freshNumber = true
  let addInput: HTMLInputElement | undefined
  let numberInput: HTMLInputElement | undefined
  let listEl: HTMLOListElement | undefined
  let barHeight = 0

  $: session = sessionId ? sessions.find((candidate) => candidate.id === sessionId) : undefined
  $: ordered = session ? orderPriorityItems(session.items) : []
  $: ensureSelection(ordered)
  $: selected = ordered.find((item) => item.id === selectedId) ?? null
  $: syncDraft(selected)
  $: scrollSelectedIntoView(selectedId, ordered)
  $: leaveMissingSession(sessions)
  $: pastSessions = [...sessions].sort((left, right) => right.createdAt.localeCompare(left.createdAt))

  function ensureSelection(order: PriorityItem[]) {
    if (order.length && !order.some((item) => item.id === selectedId)) selectedId = nextUnratedId(order, null) ?? order[0].id
  }

  function markActive() {
    if (sessionId) writeOpenSession({ id: sessionId, activeAt: Date.now() })
  }

  function leaveMissingSession(current: PrioritySession[]) {
    if (screen === 'session' && !current.some((candidate) => candidate.id === sessionId)) goHome()
  }

  function goHome() {
    writeOpenSession(null)
    screen = 'home'
    sessionId = null
    selectedId = null
    addText = ''
  }

  async function openSession(id: Id, itemId?: Id) {
    sessionId = id
    selectedId = itemId ?? null
    screen = 'session'
    markActive()
    await tick()
    if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) numberInput?.focus()
  }

  function start() {
    const id = plannerStore.startPrioritySession(defaultPrioritySeeds(projects, checkIns, goals, goalCompletions, currentDay))
    void openSession(id)
  }

  function restoreOpenSession() {
    const open = readOpenSession()
    if (open && Date.now() - open.activeAt < PRIORITIZE_IDLE_MS && sessions.some((candidate) => candidate.id === open.id)) {
      if (screen !== 'session' || sessionId !== open.id) void openSession(open.id)
    } else if (screen === 'session') {
      goHome()
    }
  }

  function handleVisibility() {
    if (document.visibilityState === 'visible') restoreOpenSession()
  }

  let unsubscribeReveal = () => {}
  onMount(() => {
    restoreOpenSession()
    unsubscribeReveal = prioritizeReveal.subscribe((target) => {
      if (!target) return
      prioritizeReveal.set(null)
      if (sessions.some((candidate) => candidate.id === target.sessionId)) void openSession(target.sessionId, target.itemId)
    })
  })
  onDestroy(() => unsubscribeReveal())

  function formatPriority(value: number | undefined) {
    return value === undefined ? '' : String(value)
  }

  function parseDraft(draft: string) {
    return draft === '' || draft === '.' ? undefined : Number(draft)
  }

  function sanitize(raw: string) {
    const [whole, ...fraction] = raw.replace(/,/g, '.').replace(/[^0-9.]/g, '').split('.')
    return (fraction.length ? `${whole}.${fraction.join('')}` : whole).slice(0, 9)
  }

  function syncDraft(item: PriorityItem | null) {
    if (!item) {
      draftItemId = null
      numberDraft = ''
    } else if (item.id !== draftItemId) {
      draftItemId = item.id
      numberDraft = formatPriority(item.priority)
      freshNumber = true
    } else if (parseDraft(numberDraft) !== item.priority) {
      numberDraft = formatPriority(item.priority)
    }
  }

  async function scrollSelectedIntoView(id: Id | null, _order: PriorityItem[]) {
    if (!id) return
    await tick()
    listEl?.querySelector<HTMLElement>(`[data-priority-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  function applyDraft(draft: string) {
    numberDraft = draft
    if (numberInput) numberInput.value = draft
    freshNumber = false
    if (!session || !selected) return
    plannerStore.setPriority(session.id, selected.id, parseDraft(draft))
    markActive()
  }

  function typeNumber(text: string) {
    applyDraft(sanitize((freshNumber ? '' : numberDraft) + text))
  }

  function move(delta: number) {
    if (!ordered.length) return
    const index = ordered.findIndex((item) => item.id === selectedId)
    selectedId = ordered[Math.max(0, Math.min(ordered.length - 1, index + delta))].id
  }

  function selectNextUnrated() {
    const id = nextUnratedId(ordered, selectedId)
    if (id && id !== selectedId) selectedId = id
    else freshNumber = true
  }

  function focusAdd(text = '') {
    addText += text
    addInput?.focus()
  }

  function focusNumber() {
    numberInput?.focus()
  }

  function isPlainKey(event: KeyboardEvent) {
    return event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing
  }

  function handleNavigationKey(event: KeyboardEvent) {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return false
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false
    event.preventDefault()
    event.stopPropagation()
    move(event.key === 'ArrowUp' ? -1 : 1)
    return true
  }

  function handleAddKeydown(event: KeyboardEvent) {
    if (event.isComposing || handleNavigationKey(event)) return
    if (event.key === 'Tab') {
      event.preventDefault()
      focusNumber()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      if (!session) return
      const id = plannerStore.addPriorityItem(session.id, addText)
      if (!id) return
      addText = ''
      selectedId = id
      markActive()
      focusNumber()
    } else if (isPlainKey(event) && /[0-9]/.test(event.key) && !addText) {
      event.preventDefault()
      focusNumber()
      typeNumber(event.key)
    }
  }

  function handleNumberKeydown(event: KeyboardEvent) {
    if (event.isComposing || handleNavigationKey(event)) return
    if (event.key === 'Tab') {
      event.preventDefault()
      focusAdd()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      selectNextUnrated()
    } else if (isPlainKey(event) && !/[0-9.,\s]/.test(event.key)) {
      event.preventDefault()
      focusAdd(event.key)
    }
  }

  // Edits always apply at the end, like a heading being typed.
  function handleNumberBeforeInput(event: InputEvent) {
    if (event.inputType.startsWith('insertComposition')) return
    event.preventDefault()
    if (event.inputType.startsWith('delete')) applyDraft(numberDraft.slice(0, -1))
    else if (event.data) typeNumber(event.data)
  }

  function handleNumberInput() {
    // Composition input cannot be cancelled; normalize what it produced.
    if (numberInput && numberInput.value !== numberDraft) applyDraft(sanitize(numberInput.value))
  }

  // Typing anywhere on the page goes to the matching field.
  function handleWindowKeydown(event: KeyboardEvent) {
    if (screen !== 'session' || event.defaultPrevented) return
    const active = document.activeElement
    if (active && active !== document.body && active.matches('input, textarea, select, [contenteditable="true"]')) return
    if (document.querySelector('.overlay-backdrop, dialog[open]')) return
    if (handleNavigationKey(event)) return
    if (!isPlainKey(event) || event.key === ' ') return
    event.preventDefault()
    if (/[0-9.]/.test(event.key)) {
      focusNumber()
      typeNumber(event.key)
    } else {
      focusAdd(event.key)
    }
  }

  function selectRow(id: Id) {
    selectedId = id
    freshNumber = true
    focusNumber()
  }

  function formatTime(iso: string, reference?: string) {
    const date = new Date(iso)
    const sameDay = reference && new Date(reference).toDateString() === date.toDateString()
    if (sameDay) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }),
      hour: 'numeric',
      minute: '2-digit',
    })
  }
</script>

<svelte:window on:keydown={handleWindowKeydown} />
<svelte:document on:visibilitychange={handleVisibility} />

<section class="prioritize-panel" class:in-session={screen === 'session'} aria-label="Prioritize">
  {#if screen === 'home'}
    <header class="page-header"><h2>Prioritize</h2></header>
    <div class="prioritize-home">
      <button class="primary prioritize-start" type="button" on:click={start}>Start prioritizing</button>
      {#if sessions.length}
        <button class="ghost" type="button" on:click={() => (screen = 'past')}>Past sessions</button>
      {/if}
    </div>
  {:else if screen === 'past'}
    <header class="page-header">
      <h2>Past sessions</h2>
      <button class="ghost" type="button" on:click={() => (screen = 'home')}>Back</button>
    </header>
    <ul class="prioritize-past">
      {#each pastSessions as past (past.id)}
        <li>
          <button type="button" on:click={() => openSession(past.id)}>
            <strong>{formatTime(past.createdAt)}</strong>
            {#if past.updatedAt !== past.createdAt}<span>Edited {formatTime(past.updatedAt, past.createdAt)}</span>{/if}
          </button>
        </li>
      {/each}
    </ul>
  {:else if session}
    <header class="page-header">
      <h2>Prioritize</h2>
      <button class="ghost" type="button" on:click={goHome}>Done</button>
    </header>
    <div class="prioritize-session" style:--prioritize-bar-height={`${barHeight}px`}>
      <div class="prioritize-entry" bind:clientHeight={barHeight}>
        <input
          class="prioritize-add"
          type="text"
          placeholder="Add priority"
          aria-label="Add priority"
          autocomplete="off"
          enterkeyhint="done"
          bind:value={addText}
          bind:this={addInput}
          on:keydown={handleAddKeydown}
        />
        <div class="prioritize-number-row">
          <input
            class="prioritize-number"
            type="text"
            inputmode="decimal"
            placeholder="#"
            aria-label={selected ? `Priority of ${selected.text}` : 'Priority'}
            autocomplete="off"
            enterkeyhint="next"
            disabled={!selected}
            value={numberDraft}
            bind:this={numberInput}
            on:focus={() => (freshNumber = true)}
            on:keydown={handleNumberKeydown}
            on:beforeinput={handleNumberBeforeInput}
            on:input={handleNumberInput}
          />
          <button
            class="ghost prioritize-next"
            type="button"
            title="Next unrated"
            aria-label="Next unrated"
            disabled={!selected}
            on:mousedown|preventDefault
            on:click={() => { selectNextUnrated(); focusNumber() }}
          >
            <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14m-6-6 6 6 6-6" /></svg>
          </button>
        </div>
      </div>
      <ol class="priority-list" bind:this={listEl}>
        {#each ordered as item, index (item.id)}
          <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
          <li
            class:selected={item.id === selectedId}
            data-priority-id={item.id}
            data-item-container-id={session.id}
            aria-current={item.id === selectedId ? 'true' : undefined}
            on:mousedown|preventDefault
            on:click={() => selectRow(item.id)}
          >
            <span class="priority-rank">{index + 1}</span>
            <span class="priority-text" title={item.text}>{item.text}</span>
            {#if item.priority !== undefined}<span class="priority-value">{item.priority}</span>{/if}
          </li>
        {/each}
      </ol>
    </div>
  {/if}
</section>

<style>
  .prioritize-panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
  }

  .page-header h2 {
    margin: 0;
  }

  .prioritize-home {
    display: flex;
    flex: 1;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    padding-bottom: 10vh;
  }

  .prioritize-start {
    padding: 14px 28px;
    border-radius: 10px;
    font-size: 18px;
    font-weight: 600;
  }

  .prioritize-past {
    display: grid;
    gap: 6px;
    width: min(520px, 100%);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .prioritize-past button {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 12px;
    width: 100%;
    padding: 10px 14px;
    border-radius: 8px;
    background: var(--paper);
    text-align: left;
  }

  .prioritize-past span {
    color: var(--muted);
    font-size: 13px;
  }

  .prioritize-session {
    display: grid;
    flex: 1;
    grid-template-columns: minmax(240px, 2fr) minmax(0, 3fr);
    gap: 32px;
    min-height: 0;
  }

  .prioritize-entry {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 20px;
    min-width: 0;
    padding-bottom: 8vh;
  }

  .prioritize-add {
    width: 100%;
    padding: 12px 14px;
    border-radius: 10px;
    font-size: 17px;
  }

  .prioritize-number-row {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .prioritize-number {
    width: 100%;
    min-width: 0;
    padding: 0 4px;
    border: 0;
    border-bottom: 2px solid var(--line);
    border-radius: 0;
    background: transparent;
    color: var(--ink);
    font-size: 56px;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    line-height: 1.2;
    caret-color: var(--accent);
  }

  .prioritize-number::placeholder {
    color: var(--line-strong);
  }

  .prioritize-number:focus {
    outline: none;
    border-bottom-color: var(--accent);
  }

  .prioritize-number:disabled {
    opacity: 0.4;
  }

  .prioritize-next {
    display: none;
    flex: none;
    width: 52px;
    height: 52px;
    padding: 0;
    border-radius: 10px;
  }

  .prioritize-next svg {
    width: 24px;
    height: 24px;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-width: 2;
  }

  .priority-list {
    min-height: 0;
    margin: 0;
    padding: 6px;
    overflow-y: auto;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
    list-style: none;
    overscroll-behavior: contain;
  }

  .priority-list li {
    display: flex;
    align-items: baseline;
    gap: 10px;
    padding: 4px 10px;
    border-radius: 6px;
    font-size: 14px;
    line-height: 1.4;
    cursor: pointer;
    scroll-margin-block: 6px;
    user-select: none;
  }

  .priority-list li:hover {
    background: color-mix(in srgb, var(--drop-inside) 45%, transparent);
  }

  .priority-list li.selected {
    background: var(--drop-inside);
    box-shadow: inset 3px 0 0 var(--accent);
  }

  .priority-rank {
    flex: none;
    min-width: 2ch;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  .priority-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .priority-value {
    flex: none;
    color: var(--accent-strong);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
  }

  /* Phone: the list reads top to bottom and the entry fields sit above the
     keyboard, with a button standing in for Enter on numeric keypads. */
  @media (max-width: 760px) {
    .prioritize-panel {
      height: auto;
      min-height: calc(100dvh - var(--mobile-header-height, 0px) - 24px);
    }

    .prioritize-home {
      min-height: 50vh;
    }

    .prioritize-session {
      display: flex;
      flex-direction: column-reverse;
      justify-content: flex-end;
      gap: 0;
    }

    .prioritize-entry {
      position: sticky;
      bottom: 0;
      z-index: 2;
      gap: 8px;
      margin: 0 -12px;
      padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
      border-top: 1px solid var(--line);
      background: var(--app-background);
      flex-direction: column-reverse;
    }

    .prioritize-number {
      font-size: 34px;
    }

    .prioritize-next {
      display: grid;
      place-items: center;
    }

    .priority-list {
      overflow: visible;
      margin-bottom: 12px;
    }

    .priority-list li {
      padding-block: 7px;
      font-size: 15px;
      scroll-margin-top: calc(var(--mobile-header-height, 0px) + 8px);
      scroll-margin-bottom: calc(var(--prioritize-bar-height) + 8px);
    }
  }
</style>
