<script lang="ts">
  import OverlayModal from './OverlayModal.svelte'
  import { situate, quizRequest, answerQuiz } from './situate/store'
  import { questions, quizProgress, type Answers } from './situate/core'
  let answers: Answers = {}
  let error = ''
  let busy = false
  let previous: unknown
  $: if ($quizRequest !== previous) { previous = $quizRequest; answers = {}; error = '' }
  $: mode = $situate.modes.find(m => m.id === $quizRequest?.mode)
  $: quiz = mode && $quizRequest ? getQuiz() : []
  $: progress = quizProgress(quiz, answers)
  function getQuiz() {
    try { return questions($situate, mode!, Date.now(), $quizRequest!.target) }
    catch (e) { error = String(e); return [] }
  }
  async function answer(value: boolean) {
    if (!progress.next || busy) return
    answers = { ...answers, [progress.next.id]: value }
    const next = quizProgress(quiz, answers)
    if (!next.next && !next.denied) await finish()
  }
  async function finish() {
    busy = true
    try { await answerQuiz(answers) } catch (e) { error = String(e) }
    finally { busy = false }
  }
</script>
{#if $quizRequest && mode}
  <OverlayModal title={mode.name} eyebrow="A moment to choose" onClose={() => quizRequest.set(null)} maxWidth={520} cover="viewport">
    <div class="quiz">
      {#if error}<p role="alert">{error}</p>
      {:else if progress.denied}
        <h2>Keep this boundary for now.</h2><p class="muted">You can come back when you’ve done what you intended.</p>
        <button type="button" on:click={() => quizRequest.set(null)}>Keep {mode.name} on</button>
      {:else if progress.next}
        <p class="muted">Question {quiz.indexOf(progress.next) + 1} of {quiz.length}</p>
        <h2>{progress.next.text}</h2>
        <div class="answers"><button disabled={busy} type="button" on:click={() => answer(false)}>No</button><button disabled={busy} type="button" on:click={() => answer(true)}>Yes</button></div>
      {:else}<button disabled={busy} type="button" on:click={finish}>Continue</button>{/if}
    </div>
  </OverlayModal>
{/if}
<style>
  .quiz { padding: 18px 4px 28px; } h2 { font-size: 1.5rem; line-height: 1.5; font-weight: 550; } .answers { display: flex; gap: 16px; margin-top: 30px; } .answers button { flex: 1; min-height: 64px; font-size: 1.2rem; border-radius: 18px; }
</style>
