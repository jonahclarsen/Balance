<script lang="ts">
  import type { Question } from './situate/core'
  import { autoGrow } from './autoGrow'
  export let questions: Question[]
  export let label: string
  export let hint = ''
  const answers: { value: boolean | null; label: string }[] = [{ value: true, label: 'Yes' }, { value: false, label: 'No' }, { value: null, label: 'Any' }]
  function add() { questions = [...questions, { id: crypto.randomUUID(), text: '', required: true }] }
  function remove(id: string) { questions = questions.filter(q => q.id !== id).map(q => q.when?.id === id ? { ...q, when: undefined } : q) }
  function update(id: string, patch: Partial<Question>) { questions = questions.map(q => q.id === id ? { ...q, ...patch } : q) }
</script>
<div class="quiz-editor" role="group" aria-label={label}>
  <div class="quiz-heading"><h4>{label}</h4>{#if hint}<span>{hint}</span>{/if}</div>
  <ol>
    {#each questions as question, i (question.id)}
      <li>
        <span class="number">{i + 1}</span>
        <div class="body">
          <textarea rows="1" value={question.text} maxlength="2000" placeholder="Question" aria-label={`${label} question ${i + 1}`} use:autoGrow={question.text} on:keydown={e => { if (e.key === 'Enter') e.preventDefault() }} on:input={e => update(question.id, { text: e.currentTarget.value.replace(/\s*\n\s*/g, ' ') })}></textarea>
          <div class="rules">
            <span class="rule-label">Pass on</span>
            <div class="choice" role="group" aria-label="Answer that passes">{#each answers as answer}<button type="button" aria-pressed={question.required === answer.value} on:click={() => update(question.id, { required: answer.value })}>{answer.label}</button>{/each}</div>
            {#if i > 0}
              <select aria-label="Ask when" value={question.when ? `${question.when.id}:${question.when.answer}` : ''} on:change={e => { const [id, answer] = e.currentTarget.value.split(':'); update(question.id, { when: id ? { id, answer: answer === 'true' } : undefined }) }}>
                <option value="">Always ask</option>
                {#each questions.slice(0, i) as earlier, j}<option value={`${earlier.id}:true`}>If {j + 1} is yes</option><option value={`${earlier.id}:false`}>If {j + 1} is no</option>{/each}
              </select>
            {/if}
          </div>
        </div>
        <button type="button" class="icon-button quiet" title="Remove" aria-label={`Remove question ${i + 1}`} on:click={() => remove(question.id)}>✕</button>
      </li>
    {/each}
  </ol>
  <button type="button" class="add" on:click={add}>+ Question</button>
</div>
<style>
  .quiz-editor { display:grid; gap:8px; }
  .quiz-heading { display:flex; align-items:baseline; gap:8px; }
  h4 { margin:0; font-size:14px; }
  .quiz-heading span { color:var(--muted); font-size:12px; }
  ol { list-style:none; margin:0; padding:0; border:1px solid var(--line); border-radius:10px; background:var(--paper-strong); }
  ol:empty { display:none; }
  li { display:grid; grid-template-columns:24px minmax(0,1fr) 30px; gap:8px; align-items:start; padding:10px; }
  li + li { border-top:1px solid var(--row-border); }
  .number { display:grid; place-items:center; width:22px; height:22px; margin-top:6px; border-radius:50%; background:var(--active-nav); color:var(--accent-strong); font-size:12px; font-weight:700; }
  .body { display:grid; gap:6px; }
  textarea { display:block; width:100%; font-size:14px; line-height:1.4; resize:none; overflow:hidden; border:1px solid var(--line); border-radius:6px; background:var(--paper-strong); color:var(--ink); padding:8px 10px; }
  textarea:focus { outline:2px solid var(--focus-ring); outline-offset:2px; }
  .rules { display:flex; flex-wrap:wrap; align-items:center; gap:8px; font-size:12px; }
  .rule-label { color:var(--muted); }
  .choice { display:inline-flex; gap:2px; padding:2px; border:1px solid var(--line); border-radius:8px; }
  .choice button { border:none; background:transparent; padding:3px 10px; border-radius:6px; font-size:12px; color:var(--muted); }
  .choice button[aria-pressed='true'] { background:var(--active-nav); color:var(--accent-strong); font-weight:650; }
  select { font-size:12px; padding:4px 6px; }
  .add { justify-self:start; font-size:13px; padding:5px 10px; }
</style>
