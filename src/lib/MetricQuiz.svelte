<script lang="ts">
  import { tick } from 'svelte'
  import { openClickedLink } from './externalLinks'
  import { escapeHTML, sanitizeInlineHTML, type ItemLink } from './planner'
  import type { Id, Metric, MetricQuestion } from './types'

  export let metric: Metric
  // Only read when the quiz opens; App remounts the quiz for each opening.
  export let revealQuestionId: Id | undefined = undefined
  export let answers: Record<Id, string>
  export let onAnswer: (questionId: Id, value: string) => void
  // Called after advancing past the last question. Dismissing the modal early
  // goes through OverlayModal's onClose instead.
  export let onComplete: () => void
  export let onOpenLink: (link: ItemLink) => void

  let root: HTMLDivElement
  let textInput: HTMLInputElement | null = null
  let answerButton: HTMLButtonElement | null = null
  // Track the question itself rather than its position so a question added,
  // removed or reordered by sync does not swap the prompt under the answer.
  let currentId = revealQuestionId ?? metric.questions[0]?.id
  let draft = ''
  let draftQuestionId: Id | null = null

  $: total = metric.questions.length
  $: index = Math.max(0, metric.questions.findIndex((candidate) => candidate.id === currentId))
  $: question = metric.questions[index] as MetricQuestion | undefined
  $: promptHTML = question ? sanitizeInlineHTML(question.html || escapeHTML(question.prompt || 'Untitled question')) : ''
  $: promptId = `metric-quiz-prompt-${metric.id}`
  $: isLast = index >= total - 1
  $: if (question && question.id !== draftQuestionId) showQuestion(question)

  function showQuestion(next: MetricQuestion) {
    draftQuestionId = next.id
    draft = answers[next.id] ?? ''
    void focusAnswer()
  }

  async function focusAnswer() {
    await tick()
    ;(question?.type === 'boolean' ? answerButton : textInput)?.focus()
    // Focusing a button leaves the caret where it was. WebKit then types
    // unhandled keys into the task behind the quiz, so drop a caret left there.
    const selection = document.getSelection()
    if (selection?.anchorNode && !root.contains(selection.anchorNode)) selection.removeAllRanges()
  }

  function goTo(offset: 1 | -1) {
    const next = metric.questions[index + offset]
    if (next) currentId = next.id
    else if (offset === 1) onComplete()
  }

  // Store only real changes: revisiting a question must not add undo history.
  function save(value: string) {
    if (question && value !== (answers[question.id] ?? '')) onAnswer(question.id, value)
  }

  function submitText() {
    save(draft.trim())
    goTo(1)
  }

  function goBack() {
    if (index === 0) return
    if (question?.type !== 'boolean') save(draft.trim())
    goTo(-1)
  }

  function answerBoolean(value: 'y' | 'n') {
    save(value)
    goTo(1)
  }

  function isEditable(target: EventTarget | null) {
    return target instanceof HTMLElement && (target.isContentEditable || target.matches('input, textarea, select'))
  }

  // Yes/no shortcuts are window-wide so they work without focus in the quiz,
  // but never while typing or while another dialog has focus.
  function handleKeydown(event: KeyboardEvent) {
    if (question?.type !== 'boolean' || event.isComposing) return
    if (event.altKey || event.ctrlKey || event.metaKey || isEditable(event.target)) return
    const focusedDialog = document.activeElement?.closest('[role="dialog"], dialog')
    if (focusedDialog && !focusedDialog.contains(root)) return

    const key = event.key.toLowerCase()
    if (!['y', 'n', 'b', 's'].includes(key)) return
    event.preventDefault()
    // A held key answers one question, not every question after it.
    if (event.repeat) return
    if (key === 'y') answerBoolean('y')
    else if (key === 'n') answerBoolean('n')
    else if (key === 'b') goBack()
    else goTo(1)
  }

  function handleTextKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter' || event.isComposing) return
    event.preventDefault()
    submitText()
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="metric-quiz" bind:this={root}>
  {#if question}
    {@const current = answers[question.id]}
    <p class="metric-progress">Question {index + 1} of {total}</p>
    <!-- svelte-ignore a11y_click_events_have_key_events a11y_no_noninteractive_element_interactions -->
    <p id={promptId} class="metric-prompt" on:click={(event) => openClickedLink(event, onOpenLink)}>{@html promptHTML}</p>

    {#if question.type === 'boolean'}
      <div class="metric-bool" role="group" aria-labelledby={promptId}>
        <button
          bind:this={answerButton}
          class="metric-bool-button"
          class:chosen={current === 'y'}
          type="button"
          aria-pressed={current === 'y'}
          on:click={() => answerBoolean('y')}
        >
          Yes <kbd>Y</kbd>
        </button>
        <button
          class="metric-bool-button"
          class:chosen={current === 'n'}
          type="button"
          aria-pressed={current === 'n'}
          on:click={() => answerBoolean('n')}
        >
          No <kbd>N</kbd>
        </button>
      </div>
    {:else}
      <input
        bind:this={textInput}
        class="metric-text-input"
        type={question.type === 'number' ? 'number' : 'text'}
        inputmode={question.type === 'number' ? 'decimal' : undefined}
        step={question.type === 'number' ? 'any' : undefined}
        value={draft}
        aria-labelledby={promptId}
        placeholder={question.type === 'number' ? 'Enter a number, press Enter' : 'Type your answer, press Enter'}
        on:input={(event) => (draft = event.currentTarget.value)}
        on:keydown={handleTextKeydown}
      />
    {/if}

    <div class="metric-quiz-nav">
      <button type="button" on:click={goBack} disabled={index === 0}>
        ← Back
        {#if question.type === 'boolean'}<kbd>B</kbd>{/if}
      </button>
      {#if question.type === 'boolean'}
        <button type="button" on:click={() => goTo(1)}>{isLast ? 'Skip and finish' : 'Skip'} <kbd>S</kbd></button>
      {:else}
        <button class="primary" type="button" on:click={submitText}>{isLast ? 'Finish' : 'Next →'}</button>
      {/if}
    </div>
  {:else}
    <p class="empty">This quiz has no questions yet.</p>
  {/if}
</div>

<style>
  .metric-quiz {
    display: grid;
    gap: 16px;
    min-width: min(420px, 70vw);
  }

  .metric-progress {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .metric-prompt {
    margin: 0;
    font-size: 20px;
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .metric-prompt :global(a) {
    color: var(--accent-strong);
    text-decoration: underline;
    cursor: pointer;
  }

  .metric-text-input {
    width: 100%;
    padding: 10px 12px;
    font-size: 16px;
  }

  .metric-bool {
    display: flex;
    gap: 12px;
  }

  .metric-bool-button {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
    padding: 14px;
    font-size: 16px;
  }

  .metric-bool-button.chosen {
    border-color: var(--accent);
    background: var(--active-nav);
    color: var(--accent-strong);
  }

  .metric-quiz kbd {
    padding: 1px 6px;
    border: 1px solid var(--line-strong);
    border-radius: 4px;
    font-size: 12px;
    color: var(--muted);
  }

  .metric-quiz-nav {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
</style>
