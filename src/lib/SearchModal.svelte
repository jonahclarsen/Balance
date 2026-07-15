<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import OverlayModal from './OverlayModal.svelte'
  import { searchBalanceState, type SearchResult } from './search'
  import type { AppState } from './types'

  export let state: AppState
  export let onClose: () => void
  export let onSelect: (result: SearchResult) => void

  const groups: { kind: SearchResult['kind']; label: string }[] = [
    { kind: 'day', label: 'Saved days' },
    { kind: 'list', label: 'List instances' },
    { kind: 'day-template', label: 'Day templates' },
    { kind: 'list-template', label: 'List templates' },
  ]

  let searchInput: HTMLInputElement | null = null
  let query = ''
  let debouncedQuery = ''
  let debounceTimer: number | null = null
  let selectedIndex = 0

  $: results = debouncedQuery ? searchBalanceState(state, debouncedQuery) : []
  $: groupedResults = groups
    .map((group) => ({ ...group, results: results.filter((result) => result.kind === group.kind) }))
    .filter((group) => group.results.length > 0)
  $: pending = query.trim() !== debouncedQuery

  onMount(() => {
    void tick().then(() => searchInput?.focus())
  })

  onDestroy(clearDebounce)

  function updateQuery(value: string) {
    query = value
    clearDebounce()

    if (!query.trim()) {
      debouncedQuery = ''
      selectedIndex = 0
      return
    }

    debounceTimer = window.setTimeout(() => {
      debouncedQuery = query.trim()
      selectedIndex = 0
      debounceTimer = null
    }, 200)
  }

  function clearDebounce() {
    if (debounceTimer === null) return
    window.clearTimeout(debounceTimer)
    debounceTimer = null
  }

  function handleKeydown(event: KeyboardEvent) {
    if (results.length === 0) return

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      selectedIndex = (selectedIndex + (event.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length
      void scrollSelectedResultIntoView()
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      onSelect(results[selectedIndex])
    }
  }

  async function scrollSelectedResultIntoView() {
    await tick()
    document.querySelector<HTMLElement>(`[data-search-result-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }
</script>

<OverlayModal title="Search" ariaLabel="Search Balance" z={80} {onClose}>
  <div class="search-modal">
    <div class="search-field">
      <span class="search-icon" aria-hidden="true">⌕</span>
      <input
        bind:this={searchInput}
        type="search"
        value={query}
        placeholder="Search days, lists, and templates"
        aria-label="Search everything"
        on:input={(event) => updateQuery(event.currentTarget.value)}
        on:keydown={handleKeydown}
      />
      {#if pending}<span class="search-pending" aria-live="polite">Searching…</span>{/if}
    </div>

    {#if !query.trim()}
      <div class="search-empty">
        <strong>Search everything you’ve planned.</strong>
        <span>Saved days, generated lists, day templates, and list templates are all included.</span>
      </div>
    {:else if !pending && results.length === 0}
      <div class="search-empty" role="status">
        <strong>No matches found</strong>
        <span>Try a different word, date, or phrase.</span>
      </div>
    {:else if results.length > 0}
      <div class="search-summary" aria-live="polite">
        {results.length} result{results.length === 1 ? '' : 's'}
      </div>
      <div class="search-results">
        {#each groupedResults as group}
          <section class="search-group" aria-labelledby={`search-group-${group.kind}`}>
            <h4 id={`search-group-${group.kind}`}>{group.label} <span>{group.results.length}</span></h4>
            <div class="search-group-results">
              {#each group.results as result (result.kind + result.id)}
                {@const resultIndex = results.indexOf(result)}
                <button
                  type="button"
                  class="search-result"
                  class:selected={selectedIndex === resultIndex}
                  data-search-result-index={resultIndex}
                  aria-label={`Open ${result.title}, ${result.meta}`}
                  on:mouseenter={() => (selectedIndex = resultIndex)}
                  on:click={() => onSelect(result)}
                >
                  <span class="search-result-topline">
                    <strong>{result.title}</strong>
                    <span>{result.meta}</span>
                  </span>
                  <span class="search-preview">{result.preview}</span>
                </button>
              {/each}
            </div>
          </section>
        {/each}
      </div>
    {/if}
  </div>
</OverlayModal>

<style>
  .search-modal {
    display: grid;
    gap: 14px;
  }

  .search-field {
    position: sticky;
    top: -18px;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    margin: -18px -18px 0;
    padding: 16px 18px 14px;
    border-bottom: 1px solid var(--line);
    background: var(--paper-strong);
  }

  .search-field input {
    width: 100%;
    padding-left: 34px;
    font-size: 16px;
  }

  .search-icon {
    position: absolute;
    left: 29px;
    color: var(--muted);
    font-size: 20px;
    pointer-events: none;
  }

  .search-pending {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 12px;
  }

  .search-empty {
    display: grid;
    justify-items: center;
    gap: 7px;
    padding: 44px 20px;
    color: var(--muted);
    text-align: center;
  }

  .search-empty strong {
    color: var(--ink);
  }

  .search-summary {
    color: var(--muted);
    font-size: 12px;
  }

  .search-results,
  .search-group,
  .search-group-results {
    display: grid;
    gap: 8px;
  }

  .search-results {
    gap: 18px;
  }

  .search-group h4 {
    display: flex;
    align-items: center;
    gap: 7px;
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  .search-group h4 span {
    display: inline-grid;
    min-width: 20px;
    min-height: 20px;
    place-items: center;
    border-radius: 999px;
    background: var(--active-nav);
    color: var(--accent-strong);
    font-size: 11px;
  }

  .search-result {
    display: grid;
    width: 100%;
    gap: 5px;
    padding: 11px 12px;
    text-align: left;
  }

  .search-result.selected {
    border-color: var(--accent);
    background: var(--active-nav);
  }

  .search-result-topline {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 14px;
  }

  .search-result-topline strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .search-result-topline > span {
    flex: 0 0 auto;
    color: var(--muted);
    font-size: 12px;
  }

  .search-preview {
    overflow: hidden;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.35;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @media (max-width: 560px) {
    .search-result-topline {
      display: grid;
      gap: 3px;
    }

    .search-result-topline > span {
      white-space: normal;
    }
  }
</style>
