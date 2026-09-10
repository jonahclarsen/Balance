<script lang="ts">
  import { onDestroy } from 'svelte'

  export let name: string

  let copied = false
  let failed = false
  let resetTimer: ReturnType<typeof setTimeout> | undefined

  onDestroy(() => clearTimeout(resetTimer))

  async function copy(event: MouseEvent) {
    event.stopPropagation()
    try {
      await navigator.clipboard.writeText(name)
      copied = true
      failed = false
      clearTimeout(resetTimer)
      resetTimer = setTimeout(() => { copied = false }, 1200)
    } catch {
      copied = false
      failed = true
    }
  }
</script>

<button
  class="goal-copy-button"
  type="button"
  aria-label={`Copy ${name}`}
  title={failed ? 'Could not copy goal name. Try again.' : copied ? 'Copied goal name' : 'Copy goal name'}
  on:click={copy}
>
  <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
    {#if copied}
      <path d="m5 12 4 4L19 6" />
    {:else}
      <path d="M9 5h6" />
      <path d="M9 4h6a2 2 0 0 1 2 2v1H7V6a2 2 0 0 1 2-2Z" />
      <path d="M7 7H6a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-1" />
    {/if}
  </svg>
</button>

<style>
  .goal-copy-button {
    flex: 0 0 auto;
    width: 26px;
    height: 26px;
  }

  .goal-copy-button svg {
    width: 18px;
    height: 18px;
  }
</style>
