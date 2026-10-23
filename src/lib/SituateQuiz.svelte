<script lang="ts">
  import { fade } from 'svelte/transition'
  import OverlayModal from './OverlayModal.svelte'
  import { situate, quizRequest, answerQuiz } from './situate/store'
  import { ACCESS_MINUTES, questions, quizProgress, type Answers, type Question } from './situate/core'
  let answers: Answers = {}
  let error = ''
  let busy = false
  let previous: unknown
  // The question stays in place while a final answer is saved, so nothing flashes before closing.
  let last: Question | undefined
  $: if ($quizRequest !== previous) { previous = $quizRequest; answers = {}; error = ''; last = undefined }
  $: mode = $situate.modes.find(m => m.id === $quizRequest?.mode)
  $: quiz = mode && $quizRequest ? getQuiz() : []
  $: progress = quizProgress(quiz, answers)
  // An entertainment pass asks how long it is needed once the quiz is passed.
  $: choosing = !!$quizRequest?.target && !progress.next && !progress.denied
  $: shown = progress.next ?? last
  // Count only questions that can still be asked, so a skipped follow-up is not counted.
  $: askable = (q: Question) => !q.when || typeof answers[q.when.id] !== 'boolean' || answers[q.when.id] === q.when.answer
  $: total = quiz.filter(askable).length
  function getQuiz() {
    try { return questions($situate, mode!, Date.now(), $quizRequest!.target) }
    catch (e) { error = String(e); return [] }
  }
  async function answer(value: boolean) {
    if (!progress.next || busy) return
    last = progress.next
    answers = { ...answers, [progress.next.id]: value }
    const next = quizProgress(quiz, answers)
    if (!next.next && !next.denied && !$quizRequest?.target) await finish()
  }
  async function finish(minutes?: number) {
    busy = true
    try { await answerQuiz(answers, minutes) } catch (e) { error = String(e) }
    finally { busy = false }
  }
</script>
{#if $quizRequest && mode}
  <OverlayModal title={`${mode.name} quiz`} onClose={() => quizRequest.set(null)} maxWidth={520} cover="viewport" z={150}>
    <div class="quiz" style:--mode={mode.color}>
      {#if error}<p role="alert">{error}</p>
      {:else if progress.denied}
        <h2>Keep this boundary for now.</h2><p class="muted">You can come back when you’ve done what you intended.</p>
        <button class="done" type="button" on:click={() => quizRequest.set(null)}>Okay</button>
      {:else if choosing}
        <div in:fade={{ duration: 140 }}>
          <p class="muted" aria-hidden="true">&nbsp;</p>
          <h2>How long?</h2>
          <div class="answers">{#each ACCESS_MINUTES as minutes}<button disabled={busy} type="button" on:click={() => finish(minutes)}>{minutes} min</button>{/each}</div>
        </div>
      {:else if shown}
        {#key shown.id}<div in:fade={{ duration: 140 }}>
          <p class="muted">Question {quiz.slice(0, quiz.indexOf(shown) + 1).filter(askable).length} of {total}</p>
          <h2>{shown.text}</h2>
          <div class="answers"><button disabled={busy || !progress.next} type="button" on:click={() => answer(false)}>No</button><button disabled={busy || !progress.next} type="button" on:click={() => answer(true)}>Yes</button></div>
        </div>{/key}
      {/if}
    </div>
  </OverlayModal>
{/if}
<style>
  .quiz { padding: 18px 4px 28px; } h2 { font-size: 1.5rem; line-height: 1.5; font-weight: 550; } .answers { display: flex; gap: 16px; margin-top: 30px; } .answers button { flex: 1; min-height: 64px; font-size: 1.2rem; border-radius: 18px; } .quiz { border-top: 4px solid var(--mode); margin-top: -4px; } .muted { color: color-mix(in srgb, var(--mode) 65%, var(--muted)); font-weight: 600; } .done { margin-top: 24px; min-width: 120px; min-height: 48px; border-color: var(--mode); background: var(--mode); color: white; font-weight: 600; } .done:hover { border-color: color-mix(in srgb, var(--mode) 85%, black); background: color-mix(in srgb, var(--mode) 85%, black); }
</style>
