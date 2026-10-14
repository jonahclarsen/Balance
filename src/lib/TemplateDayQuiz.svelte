<script lang="ts">
  import type { TemplateQuizStep } from './planner'
  import type { Id, TemplateQuizAnswers } from './types'

  export let steps: TemplateQuizStep[]
  export let onComplete: (answers: TemplateQuizAnswers) => void

  let answers: TemplateQuizAnswers = {}
  let index = 0

  // A nested question is moot once any question above it answered "none".
  $: visibleSteps = steps.filter((step) => step.questionAncestorIds.every((id) => answers[id] !== null))
  $: step = visibleSteps[index]
  $: typed = step?.typedAnswerPrefix != null
  $: yesNo = !typed && step?.options.length === 1

  function answer(value: TemplateQuizAnswers[Id]) {
    if (!step) return
    answers = { ...answers, [step.itemId]: value }
    advance()
  }

  // A blank typed answer means none.
  function answerTyped(value: string) {
    if (!step?.typedAnswerPrefix) return
    const typedText = value.trim()
    answer(typedText === '' ? null : { text: step.typedAnswerPrefix + typedText })
  }

  function typedValue(current: TemplateQuizAnswers[Id] | undefined, prefix: string): string {
    return current && typeof current === 'object' ? current.text.slice(prefix.length) : ''
  }

  function focusInput(node: HTMLInputElement) {
    node.focus()
    node.select()
  }

  // Skipping leaves the row to its usual probability roll.
  function skip() {
    if (!step) return
    const { [step.itemId]: _skipped, ...rest } = answers
    answers = rest
    advance()
  }

  function advance() {
    // Read the filter after this answer: it may have hidden later questions.
    const remaining = steps.filter((candidate) => candidate.questionAncestorIds.every((id) => answers[id] !== null))
    if (index >= remaining.length - 1) {
      onComplete(answers)
      return
    }
    index += 1
  }

  function goBack() {
    if (index > 0) index -= 1
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!step || event.target instanceof HTMLInputElement || event.altKey || event.ctrlKey || event.metaKey || event.repeat) return
    const key = event.key.toLowerCase()
    let handled = true
    if (key === 'b') goBack()
    else if (key === 's') skip()
    else if (key === 'n') answer(null)
    else if (yesNo && key === 'y') answer(step.options[0].id)
    else if (!yesNo && /^[1-9]$/.test(key) && step.options[Number(key) - 1]) answer(step.options[Number(key) - 1].id)
    else handled = false
    if (handled) event.preventDefault()
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="day-quiz">
  {#if step}
    {@const current = answers[step.itemId]}
    <p class="day-quiz-progress">Question {index + 1} of {visibleSteps.length}</p>
    <p class="day-quiz-prompt">{step.question}</p>

    {#if step.typedAnswerPrefix != null}
      {@const prefix = step.typedAnswerPrefix}
      {#key step.itemId}
        <form class="day-quiz-typed" on:submit|preventDefault={(event) => answerTyped(new FormData(event.currentTarget).get('answer')?.toString() ?? '')}>
          <input name="answer" type="text" aria-label={step.question} value={typedValue(current, prefix)} autocomplete="off" use:focusInput />
          <button type="submit">Next <kbd>↵</kbd></button>
        </form>
      {/key}
    {:else if yesNo}
      <p class="day-quiz-detail">Yes adds “{step.options[0].text.trim() || 'this row'}”.</p>
    {/if}

    {#if !typed}
    <div class="day-quiz-answers" class:yes-no={yesNo}>
      {#if yesNo}
        <button type="button" class:chosen={current === step.options[0].id} on:click={() => answer(step.options[0].id)}>
          Yes <kbd>Y</kbd>
        </button>
      {:else}
        {#each step.options as option, optionIndex (option.id)}
          <button type="button" class:chosen={current === option.id} on:click={() => answer(option.id)}>
            <span>{option.text.trim() || '(Skip)'}</span>
            {#if optionIndex < 9}<kbd>{optionIndex + 1}</kbd>{/if}
          </button>
        {/each}
      {/if}
      <button type="button" class:chosen={current === null} on:click={() => answer(null)}>
        {yesNo ? 'No' : 'None'} <kbd>N</kbd>
      </button>
    </div>
    {/if}

    <div class="day-quiz-nav">
      <button type="button" on:click={goBack} disabled={index === 0}>← Back{#if !typed} <kbd>B</kbd>{/if}</button>
      <button type="button" title="Leave this row to its usual odds" on:click={skip}>Skip{#if !typed} <kbd>S</kbd>{/if} →</button>
    </div>
  {/if}
</div>

<style>
  .day-quiz {
    display: grid;
    gap: 16px;
    min-width: min(420px, 70vw);
  }

  .day-quiz p {
    margin: 0;
  }

  .day-quiz-progress {
    color: var(--muted);
    font-size: 12px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .day-quiz-prompt {
    font-size: 20px;
    font-weight: 600;
  }

  .day-quiz-detail {
    margin-top: -8px !important;
    color: var(--muted);
  }

  .day-quiz-typed {
    display: flex;
    gap: 8px;
  }

  .day-quiz-typed input {
    flex: 1;
    min-width: 0;
    padding: 12px 14px;
    font-size: 16px;
  }

  .day-quiz-answers {
    display: grid;
    gap: 8px;
  }

  .day-quiz-answers.yes-no {
    grid-template-columns: 1fr 1fr;
    gap: 12px;
  }

  .day-quiz-answers button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 12px 14px;
    font-size: 16px;
    text-align: left;
  }

  .day-quiz-answers.yes-no button {
    justify-content: center;
    padding: 14px;
  }

  .day-quiz-answers button.chosen {
    border-color: var(--accent);
    background: var(--active-nav);
    color: var(--accent-strong);
  }

  .day-quiz kbd {
    padding: 1px 6px;
    border: 1px solid var(--line-strong);
    border-radius: 4px;
    font-size: 12px;
    color: var(--muted);
  }

  .day-quiz-nav {
    display: flex;
    justify-content: space-between;
    gap: 12px;
  }
</style>
