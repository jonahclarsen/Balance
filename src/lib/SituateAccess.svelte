<script lang="ts">
  import { onDestroy } from 'svelte'
  import { get } from 'svelte/store'
  import { situate, mutateSituate } from './situate/store'
  import { validate, type Question } from './situate/core'
  import SituateQuestionEditor from './SituateQuestionEditor.svelte'
  // One quiz for every mode that blocks a site; edits save shortly after they are made.
  let draft: Question[] = structuredClone(get(situate).accessQuiz)
  let saved = JSON.stringify(draft)
  let error = ''
  let timer: number | undefined
  // Rules loaded or changed elsewhere replace the draft unless an edit is pending.
  $: incoming = JSON.stringify($situate.accessQuiz)
  $: if (incoming !== saved && JSON.stringify(draft) === saved) { draft = JSON.parse(incoming); saved = incoming }
  $: queue(draft)
  function queue(value: Question[]) {
    if (JSON.stringify(value) === saved) return
    window.clearTimeout(timer)
    timer = window.setTimeout(flush, 300)
  }
  function flush() {
    window.clearTimeout(timer)
    const raw = JSON.stringify(draft)
    if (raw === saved) return
    const accessQuiz: Question[] = JSON.parse(raw)
    try { validate({ ...get(situate), accessQuiz }); error = '' } catch (e) { error = e instanceof Error ? e.message : String(e); return }
    saved = raw
    mutateSituate(d => ({ ...d, accessQuiz })).catch(e => { error = String(e); saved = '' })
  }
  onDestroy(flush)
</script>
<div class="access">
  <SituateQuestionEditor label="Quiz" bind:questions={draft} />
  {#if error}<p class="error" role="alert">{error}</p>{/if}
</div>
<style>
  .access { display:grid; gap:14px; max-width:520px; }
  .error { margin:0; color:var(--danger); }
</style>
