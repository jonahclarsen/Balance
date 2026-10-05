<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import { plannerStore } from './store'
  import ImaxButton from './ImaxButton.svelte'
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
  export let maximized = false
  export let onToggleMaximized: (event: MouseEvent) => void

  // Touch keyboards need a real (invisible) input behind the number card.
  const touch = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches

  let screen: 'home' | 'past' | 'session' = 'home'
  let sessionId: Id | null = null
  let selectedId: Id | null = null
  let addText = ''
  let numberDraft = ''
  let draftItemId: Id | null = null
  let editingId: Id | null = null
  let editText = ''
  let addInput: HTMLInputElement | undefined
  let numberCard: HTMLDivElement | undefined
  let numberProxy: HTMLInputElement | undefined
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
    editingId = null
    addText = ''
  }

  async function openSession(id: Id, itemId?: Id) {
    sessionId = id
    selectedId = itemId ?? null
    editingId = null
    screen = 'session'
    markActive()
    await tick()
    if (!touch) focusNumber()
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
    } else if (item.id !== draftItemId || parseDraft(numberDraft) !== item.priority) {
      draftItemId = item.id
      numberDraft = formatPriority(item.priority)
    }
    if (numberProxy) numberProxy.value = numberDraft
  }

  async function scrollSelectedIntoView(id: Id | null, _order: PriorityItem[]) {
    if (!id) return
    await tick()
    listEl?.querySelector<HTMLElement>(`[data-priority-id="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  function applyDraft(draft: string) {
    numberDraft = draft
    if (numberProxy) numberProxy.value = draft
    if (!session || !selected) return
    plannerStore.setPriority(session.id, selected.id, parseDraft(draft))
    markActive()
  }

  function typeNumber(text: string) {
    applyDraft(sanitize(numberDraft + text))
  }

  function move(delta: number) {
    if (!ordered.length) return
    const index = ordered.findIndex((item) => item.id === selectedId)
    selectedId = ordered[(index + delta + ordered.length) % ordered.length].id
  }

  function selectNextUnrated() {
    const id = nextUnratedId(ordered, selectedId)
    if (id) selectedId = id
  }

  function focusAdd(text = '') {
    addText += text
    addInput?.focus()
  }

  function focusNumber() {
    if (touch) numberProxy?.focus()
    else numberCard?.focus()
  }

  // Shift or Ctrl with a number key types the digit itself.
  function digitFromCode(event: KeyboardEvent) {
    return /^(?:Digit|Numpad)(\d)$/.exec(event.code)?.[1] ?? null
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
    const digit = digitFromCode(event)
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
    } else if (digit && (event.shiftKey || event.ctrlKey) && !event.metaKey && !event.altKey && addInput) {
      event.preventDefault()
      addInput.setRangeText(digit, addInput.selectionStart ?? addText.length, addInput.selectionEnd ?? addText.length, 'end')
      addText = addInput.value
    } else if (!touch && isPlainKey(event) && /[0-9]/.test(event.key)) {
      event.preventDefault()
      focusNumber()
      typeNumber(event.key)
    }
  }

  function handleNumberKeydown(event: KeyboardEvent) {
    if (event.isComposing || handleNavigationKey(event)) return
    const digit = digitFromCode(event)
    if (event.key === 'Tab') {
      event.preventDefault()
      focusAdd()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      event.stopPropagation()
      selectNextUnrated()
    } else if (event.key === 'Backspace' || event.key === 'Delete') {
      event.preventDefault()
      event.stopPropagation()
      applyDraft(event.metaKey || event.ctrlKey || event.altKey ? '' : numberDraft.slice(0, -1))
    } else if (digit && !event.metaKey && !event.ctrlKey && !event.altKey) {
      event.preventDefault()
      typeNumber(digit)
    } else if (isPlainKey(event) && /[.,]/.test(event.key)) {
      event.preventDefault()
      typeNumber('.')
    } else if (isPlainKey(event) && event.key !== ' ') {
      event.preventDefault()
      focusAdd(event.key)
    }
  }

  // Touch keyboards that skip key events edit through input events instead.
  function handleProxyBeforeInput(event: InputEvent) {
    if (event.inputType.startsWith('insertComposition')) return
    event.preventDefault()
    if (event.inputType === 'deleteContentBackward') applyDraft(numberDraft.slice(0, -1))
    else if (event.inputType.startsWith('delete')) applyDraft('')
    else if (event.data) typeNumber(event.data)
  }

  function handleProxyInput() {
    if (numberProxy && numberProxy.value !== numberDraft) applyDraft(sanitize(numberProxy.value))
  }

  // Typing anywhere on the page goes to the matching field.
  function handleWindowKeydown(event: KeyboardEvent) {
    if (screen !== 'session' || event.defaultPrevented) return
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.code === 'KeyD') {
      event.preventDefault()
      if (selectedId && !event.repeat) deleteItem(selectedId)
      return
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.code === 'KeyE') {
      event.preventDefault()
      if (selected && !event.repeat) startEdit(selected)
      return
    }
    const active = document.activeElement
    if (active && active !== document.body && (active === numberCard || active.matches('input, textarea, select, [contenteditable="true"]'))) return
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

  // Selection moves to the row that takes the deleted row's place.
  function deleteItem(id: Id) {
    if (!session) return
    const index = ordered.findIndex((item) => item.id === id)
    if (id === editingId) editingId = null
    plannerStore.deletePriorityItem(session.id, id)
    markActive()
    if (id === selectedId) selectedId = (ordered[index + 1] ?? ordered[index - 1])?.id ?? null
  }

  function selectRow(id: Id) {
    selectedId = id
    focusNumber()
  }

  function startEdit(item: PriorityItem) {
    commitEdit()
    selectedId = item.id
    editingId = item.id
    editText = item.text
  }

  function commitEdit() {
    if (!editingId || !session) return
    const id = editingId
    editingId = null
    if (editText.trim() && editText !== session.items.find((item) => item.id === id)?.text) {
      plannerStore.renamePriorityItem(session.id, id, editText)
      markActive()
    }
  }

  function handleEditKeydown(event: KeyboardEvent) {
    event.stopPropagation()
    if (event.isComposing) return
    if (event.key === 'Enter' || event.key === 'Escape') {
      event.preventDefault()
      commitEdit()
      focusNumber()
    }
  }

  function fitHeight(field: HTMLTextAreaElement) {
    field.style.height = 'auto'
    field.style.height = `${field.scrollHeight}px`
  }

  function focusAtEnd(field: HTMLTextAreaElement) {
    fitHeight(field)
    field.focus()
    field.setSelectionRange(field.value.length, field.value.length)
  }

  // Priorities are single lines that wrap; pasted line breaks become spaces.
  function handleEditInput(event: Event & { currentTarget: HTMLTextAreaElement }) {
    if (/[\r\n]/.test(editText)) editText = event.currentTarget.value = editText.replace(/[\r\n]+/g, ' ')
    fitHeight(event.currentTarget)
  }

  function formatTime(iso: string) {
    const date = new Date(iso)
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

<section class="prioritize-panel" aria-label="Prioritize">
  {#if screen === 'home'}
    <ImaxButton active={maximized} onToggle={onToggleMaximized} />
    <header class="page-header"><h2>Prioritize</h2></header>
    <div class="prioritize-home">
      <button class="primary prioritize-start" type="button" on:click={start}>Start prioritizing</button>
      {#if sessions.length}
        <button class="ghost" type="button" on:click={() => (screen = 'past')}>Past sessions</button>
      {/if}
    </div>
  {:else if screen === 'past'}
    <header class="page-header prioritize-past-header">
      <button class="ghost prioritize-back" type="button" on:click={() => (screen = 'home')}>Back</button>
      <ImaxButton active={maximized} onToggle={onToggleMaximized} />
      <h2>Past sessions</h2>
    </header>
    <ul class="prioritize-past">
      {#each pastSessions as past (past.id)}
        <li>
          <button type="button" on:click={() => openSession(past.id)}>
            <strong>{formatTime(past.createdAt)}</strong>
            <span class="prioritize-past-edited">Last edited: {formatTime(past.updatedAt)}</span>
            <span class="prioritize-past-top">
              {#each orderPriorityItems(past.items).slice(0, 6) as item, index (item.id)}
                <span class="prioritize-past-row">
                  <span class="priority-rank">{index + 1}</span>
                  <span class="prioritize-past-text">{item.text}</span>
                  {#if item.priority !== undefined}<span class="priority-value">{item.priority}</span>{/if}
                </span>
              {/each}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  {:else if session}
    <div class="prioritize-session" style:--prioritize-bar-height={`${barHeight}px`}>
      <div class="prioritize-toolbar">
        <button class="ghost prioritize-back" type="button" on:click={goHome}>Back</button>
        <ImaxButton active={maximized} onToggle={onToggleMaximized} />
      </div>
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
          <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_click_events_have_key_events -->
          <div
            class="prioritize-number"
            class:disabled={!selected}
            role="textbox"
            tabindex={touch ? -1 : 0}
            aria-label={selected ? `Priority of ${selected.text}` : 'Priority'}
            bind:this={numberCard}
            on:mousedown|preventDefault
            on:click={focusNumber}
            on:keydown={handleNumberKeydown}
          >
            <h3 class:unset={!numberDraft}>{numberDraft || '0'}</h3>
            {#if touch}
              <input
                class="prioritize-number-proxy"
                type="text"
                inputmode="decimal"
                enterkeyhint="next"
                autocomplete="off"
                aria-hidden="true"
                tabindex="-1"
                disabled={!selected}
                bind:this={numberProxy}
                on:beforeinput={handleProxyBeforeInput}
                on:input={handleProxyInput}
              />
            {/if}
          </div>
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
            {#if item.id === selectedId}
              <button
                class="priority-delete"
                type="button"
                title="Delete"
                aria-label={`Delete ${item.text}`}
                on:mousedown|preventDefault|stopPropagation
                on:click|stopPropagation={() => deleteItem(item.id)}
              >
                <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m7 7 10 10M17 7 7 17" /></svg>
              </button>
            {:else}
              <span class="priority-delete-slot" aria-hidden="true"></span>
            {/if}
            <span class="priority-rank">{index + 1}</span>
            {#if editingId === item.id}
              <textarea
                class="priority-text-edit"
                rows="1"
                aria-label="Priority text"
                enterkeyhint="done"
                bind:value={editText}
                use:focusAtEnd
                on:input={handleEditInput}
                on:mousedown|stopPropagation
                on:click|stopPropagation
                on:keydown={handleEditKeydown}
                on:blur={commitEdit}
              ></textarea>
            {:else}
              <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
              <span class="priority-text" on:click|stopPropagation={() => startEdit(item)}>{item.text}</span>
            {/if}
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

  .prioritize-panel > :global(.imax-button) {
    align-self: flex-start;
    margin-bottom: 8px;
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

  .prioritize-past-header {
    justify-content: flex-start;
    gap: 8px;
  }

  .prioritize-past-header h2 {
    margin-left: 8px;
  }

  /* IMAX hides page headers; keep these, minus titles, for Back and exit. */
  :global(.app-shell.page-maximized) .prioritize-panel .page-header {
    display: flex;
  }

  :global(.app-shell.page-maximized) .prioritize-panel .page-header h2 {
    visibility: hidden;
  }

  .prioritize-back {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding-left: 8px;
  }

  .prioritize-back::before {
    content: '‹';
    font-size: 1.3em;
    line-height: 0.8;
  }

  .prioritize-past {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 280px), 1fr));
    gap: 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .prioritize-past button {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    height: 100%;
    padding: 14px 16px;
    border-radius: 10px;
    background: var(--paper);
    text-align: left;
  }

  .prioritize-past strong {
    font-size: 16px;
  }

  .prioritize-past-edited {
    color: var(--muted);
    font-size: 12px;
    font-weight: 400;
  }

  .prioritize-past-top {
    display: grid;
    gap: 2px;
    margin-top: 10px;
  }

  .prioritize-past-row {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-size: 13px;
  }

  .prioritize-past-text {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .prioritize-session {
    display: grid;
    flex: 1;
    grid-template-areas: 'back list' 'entry list';
    grid-template-columns: minmax(240px, 2fr) minmax(0, 3fr);
    grid-template-rows: auto minmax(0, 1fr);
    column-gap: 32px;
    min-height: 0;
  }

  .prioritize-toolbar {
    display: flex;
    grid-area: back;
    align-items: center;
    gap: 8px;
  }

  .prioritize-entry {
    display: flex;
    grid-area: entry;
    flex-direction: column;
    justify-content: center;
    gap: 16px;
    min-width: 0;
    padding-bottom: 8vh;
  }

  .prioritize-add {
    width: 100%;
    padding: 12px 14px;
    border-radius: 10px;
    font-size: 17px;
    text-align: center;
  }

  .prioritize-number-row {
    display: flex;
    align-items: stretch;
    gap: 8px;
  }

  .prioritize-number {
    position: relative;
    flex: 1;
    min-width: 0;
    padding: 18px 14px;
    border: 1px solid var(--line);
    border-radius: 12px;
    background: var(--paper);
    box-shadow: var(--shadow);
    cursor: pointer;
    text-align: center;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }

  .prioritize-number:hover {
    border-color: var(--line-strong);
  }

  .prioritize-number:focus-visible,
  .prioritize-number:focus-within,
  .prioritize-number:focus {
    border-color: var(--accent);
    outline: none;
    box-shadow: 0 0 0 3px var(--focus-ring), var(--shadow);
  }

  .prioritize-number.disabled {
    opacity: 0.4;
    pointer-events: none;
  }

  .prioritize-number h3 {
    margin: 0;
    color: var(--ink);
    font-size: 56px;
    font-variant-numeric: tabular-nums;
    font-weight: 700;
    line-height: 1.1;
    overflow-wrap: anywhere;
  }

  .prioritize-number h3.unset {
    color: var(--line-strong);
  }

  .prioritize-number-proxy {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    padding: 0;
    border: 0;
    opacity: 0;
    font-size: 16px;
    caret-color: transparent;
  }

  .prioritize-next {
    display: none;
    flex: none;
    width: 52px;
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
    grid-area: list;
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
    line-height: 20px;
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

  .priority-delete,
  .priority-delete-slot {
    flex: none;
    width: 16px;
    margin-right: -6px;
  }

  .priority-delete {
    align-self: center;
    height: 16px;
    padding: 0;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: var(--muted);
  }

  .priority-delete:hover {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
  }

  .priority-delete svg {
    display: block;
    width: 100%;
    height: 100%;
    fill: none;
    stroke: currentColor;
    stroke-linecap: round;
    stroke-width: 2.2;
  }

  .priority-rank {
    flex: none;
    min-width: 2ch;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
    text-align: right;
  }

  /* Only the words are an edit target; the rest of the row selects it. */
  .priority-text,
  .priority-text-edit {
    min-width: 0;
    margin: 0 -5px;
    padding: 0 5px;
    border-radius: 4px;
    font: inherit;
    line-height: 20px;
  }

  .priority-text {
    flex: 0 1 auto;
    overflow-wrap: anywhere;
    cursor: text;
  }

  .priority-text:hover {
    background: var(--paper-strong);
    box-shadow: inset 0 0 0 1px var(--line-strong);
  }

  .priority-text-edit {
    display: block;
    flex: 1;
    overflow: hidden;
    border: 0;
    resize: none;
    background: var(--paper-strong);
    color: var(--ink);
    box-shadow: inset 0 0 0 1px var(--accent);
    outline: none;
  }

  .priority-value {
    flex: none;
    margin-left: auto;
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
      flex-direction: column;
    }

    .prioritize-toolbar {
      margin-bottom: 8px;
    }

    .priority-list {
      flex: 1 0 auto;
      overflow: visible;
      margin-bottom: 12px;
    }

    .prioritize-entry {
      position: sticky;
      bottom: 0;
      z-index: 2;
      order: 1;
      flex-direction: column-reverse;
      gap: 8px;
      margin: 0 -12px;
      padding: 10px 12px calc(10px + env(safe-area-inset-bottom));
      border-top: 1px solid var(--line);
      background: var(--app-background);
    }

    .prioritize-number {
      padding: 8px 12px;
      box-shadow: none;
    }

    .prioritize-number h3 {
      font-size: 34px;
    }

    .prioritize-next {
      display: grid;
      place-items: center;
    }

    .priority-list li {
      padding-block: 7px;
      font-size: 15px;
      scroll-margin-top: calc(var(--mobile-header-height, 0px) + 8px);
      scroll-margin-bottom: calc(var(--prioritize-bar-height) + 8px);
    }
  }
</style>
