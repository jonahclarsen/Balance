<script lang="ts">
  import type { Question } from './situate/core'
  export let questions: Question[]
  export let label: string
  function add() { questions = [...questions, { id: crypto.randomUUID(), text: '', required: true }] }
  function remove(id: string) { questions = questions.filter(q => q.id !== id).map(q => q.when?.id === id ? { ...q, when: undefined } : q) }
</script>
<fieldset><legend>{label}</legend>
{#each questions as question, i (question.id)}
  <div class="question-row">
    <label>Question {i + 1}<input bind:value={question.text} maxlength="2000" /></label>
    <label>Required answer<select bind:value={question.required}><option value={true}>Yes</option><option value={false}>No</option><option value={null}>Either (branch only)</option></select></label>
    {#if i > 0}<label>Ask when<select value={question.when?.id ?? ''} on:change={e => { question.when = e.currentTarget.value ? { id: e.currentTarget.value, answer: true } : undefined; questions = [...questions] }}><option value="">Always</option>{#each questions.slice(0,i) as earlier}<option value={earlier.id}>{earlier.text || 'Untitled question'}</option>{/each}</select></label>{/if}
    {#if question.when}<label>Was answered<select bind:value={question.when.answer}><option value={true}>Yes</option><option value={false}>No</option></select></label>{/if}
    <button type="button" aria-label={`Remove question ${i + 1}`} on:click={() => remove(question.id)}><svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18" fill="none" stroke="currentColor" stroke-width="2"/></svg></button>
  </div>
{/each}
<button type="button" on:click={add}>Add question</button>
</fieldset>
<style>fieldset { border:1px solid var(--border); border-radius:12px; margin:16px 0; padding:12px; } .question-row { display:flex; gap:10px; align-items:end; flex-wrap:wrap; padding:10px 0; } label { display:grid; gap:5px; flex:1; min-width:130px; } input, select { width:100%; } </style>
