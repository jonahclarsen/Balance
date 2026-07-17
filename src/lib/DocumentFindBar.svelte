<script lang="ts">
  import { onMount, tick } from 'svelte'

  export let onClose: () => void

  let input: HTMLInputElement | null = null
  let query = ''
  let found: boolean | null = null

  onMount(() => {
    void focus()
  })

  export async function focus() {
    await tick()
    input?.focus()
    input?.select()
  }

  function find(backwards = false) {
    if (!query) {
      found = null
      return
    }

    const findInPage = (window as Window & {
      find?: (
        text: string,
        caseSensitive?: boolean,
        backwards?: boolean,
        wrapAround?: boolean,
        wholeWord?: boolean,
        searchInFrames?: boolean,
        showDialog?: boolean,
      ) => boolean
    }).find

    found = findInPage?.call(window, query, false, backwards, true, false, false, false) ?? false
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return
    event.preventDefault()
    find(event.shiftKey)
  }
</script>

<div class="document-find" role="search" aria-label="Find in current document">
  <input
    bind:this={input}
    type="search"
    aria-label="Find text"
    placeholder="Find in current view"
    bind:value={query}
    on:input={() => find()}
    on:keydown={handleKeydown}
  />
  <span class:missing={found === false} class="find-status" role="status">
    {found === false ? 'No matches' : found === true ? 'Match' : ''}
  </span>
  <button type="button" title="Previous match (Shift+Enter)" aria-label="Previous match" on:click={() => find(true)}>↑</button>
  <button type="button" title="Next match (Enter)" aria-label="Next match" on:click={() => find()}>↓</button>
  <button type="button" title="Close (Escape)" aria-label="Close find" on:click={onClose}>×</button>
</div>

<style>
  .document-find {
    position: fixed;
    z-index: 75;
    top: max(10px, env(safe-area-inset-top));
    right: 14px;
    display: flex;
    align-items: center;
    gap: 5px;
    padding: 7px;
    border: 1px solid var(--line-strong);
    border-radius: 8px;
    background: var(--paper-strong);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
  }

  input {
    width: min(230px, 42vw);
    padding-block: 6px;
  }

  .find-status {
    min-width: 40px;
    color: var(--muted);
    font-size: 11px;
    text-align: center;
    white-space: nowrap;
  }

  .find-status.missing {
    color: var(--danger);
  }

  button {
    width: 28px;
    height: 28px;
    padding: 0;
    text-align: center;
  }

  @media (max-width: 520px) {
    .document-find {
      right: 8px;
      left: 8px;
    }

    input {
      width: 100%;
      min-width: 0;
    }

    .find-status {
      display: none;
    }
  }
</style>
