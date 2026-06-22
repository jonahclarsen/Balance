<script lang="ts">
  import { tick } from 'svelte'
  import { escapeHTML } from './planner'
  import type { Id, Metric } from './types'

  export let metric: Metric
  export let answers: Record<Id, string>
  export let onAnswer: (questionId: Id, value: string) => void
  export let onClose: () => void

  let index = 0
  let draft = ''
  let lastIndex = -1
  let textInput: HTMLInputElement | null = null

  $: question = metric.questions[index]
  $: total = metric.questions.length

  // Seed the draft from the stored answer whenever we land on a new question.
  $: if (question && index !== lastIndex) {
    lastIndex = index
    draft = answers[question.id] ?? ''
    void focusTextSoon()
  }

  async function focusTextSoon() {
    await tick()
    if (question?.type === 'text') textInput?.focus()
  }

  function advance() {
    if (index >= total - 1) {
      onClose()
      return
    }
    index += 1
  }

  function goBack() {
    if (index > 0) index -= 1
  }

  function submitText() {
    if (question) onAnswer(question.id, draft.trim())
    advance()
  }

  function setBoolean(value: 'y' | 'n') {
    if (question) onAnswer(question.id, value)
    advance()
  }

  function handleKeydown(event: KeyboardEvent) {
    if (!question) return
    if (question.type === 'boolean') {
      const key = event.key.toLowerCase()
      if (key === 'y') {
        event.preventDefault()
        setBoolean('y')
      } else if (key === 'n') {
        event.preventDefault()
        setBoolean('n')
      }
    }
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div class="metric-quiz">
  {#if question}
    <p class="metric-progress">Question {index + 1} of {total}</p>
    <p class="metric-prompt">{@html question.html || escapeHTML(question.prompt || 'Untitled question')}</p>

    {#if question.type === 'boolean'}
      {@const current = answers[question.id] ?? draft}
      <div class="metric-bool">
        <button class="metric-bool-button" class:chosen={current === 'y'} type="button" on:click={() => setBoolean('y')}>
          Yes <kbd>Y</kbd>
        </button>
        <button class="metric-bool-button" class:chosen={current === 'n'} type="button" on:click={() => setBoolean('n')}>
          No <kbd>N</kbd>
        </button>
      </div>
    {:else}
      <input
        bind:this={textInput}
        class="metric-text-input"
        type="text"
        value={draft}
        placeholder="Type your answer, press Enter"
        on:input={(event) => (draft = event.currentTarget.value)}
        on:keydown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submitText()
          }
        }}
      />
    {/if}

    <div class="metric-quiz-nav">
      <button type="button" on:click={goBack} disabled={index === 0}>← Back</button>
      {#if question.type === 'text'}
        <button class="primary" type="button" on:click={submitText}>
          {index >= total - 1 ? 'Finish' : 'Next →'}
        </button>
      {:else}
        <button type="button" on:click={advance}>Skip →</button>
      {/if}
    </div>
  {:else}
    <p class="empty">This metric has no questions yet.</p>
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

  .metric-bool-button kbd {
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
