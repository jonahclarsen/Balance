<script lang="ts">
  import { tick } from 'svelte'
  import RichTextEditor from './RichTextEditor.svelte'
  import TreeItemRow from './TreeItemRow.svelte'
  import type { Id, MetricQuestion, MetricQuestionType, MoveDirection, MovePlacement } from './types'

  export let metricId: Id
  export let question: MetricQuestion
  export let questionIds: Id[]
  export let historyRevision: number
  export let patchQuestion: (
    metricId: Id,
    questionId: Id,
    patch: Partial<Pick<MetricQuestion, 'prompt' | 'html' | 'type'>>,
  ) => void
  export let splitQuestion: (
    metricId: Id,
    questionId: Id,
    before: Pick<MetricQuestion, 'prompt' | 'html'>,
    after: Pick<MetricQuestion, 'prompt' | 'html'>,
  ) => Id
  export let deleteQuestion: (metricId: Id, questionId: Id) => void
  export let moveQuestion: (
    metricId: Id,
    sourceId: Id,
    targetId: Id,
    placement: MovePlacement,
  ) => void

  const questionTypes: { type: MetricQuestionType; label: string }[] = [
    { type: 'text', label: 'Text' },
    { type: 'number', label: 'Number' },
    { type: 'boolean', label: 'Yes / no' },
  ]

  async function handleSplit(
    before: { html: string; text: string },
    after: { html: string; text: string },
  ) {
    const newQuestionId = splitQuestion(
      metricId,
      question.id,
      { html: before.html, prompt: before.text },
      { html: after.html, prompt: after.text },
    )
    await tick()
    focusQuestion(newQuestionId, 'start')
  }

  async function handleArrowKey(direction: MoveDirection, _editor: HTMLDivElement, event: KeyboardEvent) {
    const index = questionIds.indexOf(question.id)
    const targetId = questionIds[direction === 'up' ? index - 1 : index + 1]
    if (!targetId) return

    if (event.altKey) {
      moveQuestion(metricId, question.id, targetId, direction === 'up' ? 'before' : 'after')
      await tick()
      focusQuestion(question.id)
      return
    }

    focusQuestion(targetId, direction === 'up' ? 'end' : 'start')
  }

  function focusQuestion(questionId: Id, position: 'start' | 'end' = 'end') {
    const editor = Array.from(document.querySelectorAll<HTMLDivElement>('[data-metric-question-text-input]')).find(
      (candidate) => candidate.dataset.metricQuestionTextInputId === questionId,
    )
    if (!editor) return

    editor.focus()
    const range = document.createRange()
    range.selectNodeContents(editor)
    range.collapse(position === 'start')
    const selection = document.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
  }
</script>

<TreeItemRow
  kind="metric"
  itemId={question.id}
  containerId={metricId}
  ariaLabel={`Metric question: ${question.prompt || 'Untitled'}`}
  dragLabel="Drag to move question"
  showSelectionHandle={false}
  moveItem={moveQuestion}
>
  <RichTextEditor
    className="metric-question-prompt"
    kind="metric-question"
    inputId={question.id}
    placeholder="Question prompt"
    html={question.html}
    text={question.prompt}
    ariaLabel="Question prompt"
    revision={historyRevision}
    onChange={(html, prompt) => patchQuestion(metricId, question.id, { html, prompt })}
    onSplit={handleSplit}
    onArrowKey={handleArrowKey}
  />

  <div class="segmented metric-question-types" role="group" aria-label="Question type">
    {#each questionTypes as option (option.type)}
      <button
        type="button"
        class:active={question.type === option.type}
        aria-pressed={question.type === option.type}
        on:click={() => patchQuestion(metricId, question.id, { type: option.type })}
      >{option.label}</button>
    {/each}
  </div>

  <button
    class="icon-button danger metric-question-delete"
    type="button"
    title="Delete question"
    aria-label="Delete question"
    on:click={() => deleteQuestion(metricId, question.id)}
  >×</button>
</TreeItemRow>
