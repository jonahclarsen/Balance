<script lang="ts">
  import { COMPLETION_CELEBRATION_OPTIONS, type CompletionCelebrationId } from './celebrations'

  export let selectedId: CompletionCelebrationId
  export let onSelect: (id: CompletionCelebrationId) => void

  let grid: HTMLDivElement
  let rovingId: CompletionCelebrationId = selectedId
  let previousSelectedId = selectedId

  $: if (selectedId !== previousSelectedId) {
    previousSelectedId = selectedId
    rovingId = selectedId
  }

  function columnCount(): number {
    const buttons = Array.from(grid?.querySelectorAll<HTMLButtonElement>('.celebration-option-button') ?? [])
    if (buttons.length < 2) return 1
    const firstTop = buttons[0].offsetTop
    const columns = buttons.findIndex((button) => button.offsetTop !== firstTop)
    return columns < 1 ? buttons.length : columns
  }

  function focusAt(index: number) {
    const celebrations = COMPLETION_CELEBRATION_OPTIONS
    const boundedIndex = Math.max(0, Math.min(celebrations.length - 1, index))
    rovingId = celebrations[boundedIndex].id
    requestAnimationFrame(() => {
      grid
        ?.querySelector<HTMLButtonElement>(`[data-celebration-option="${rovingId}"]`)
        ?.focus()
    })
  }

  function handleGridKeydown(event: KeyboardEvent, index: number) {
    let nextIndex: number | null = null
    if (event.key === 'ArrowLeft') nextIndex = index - 1
    else if (event.key === 'ArrowRight') nextIndex = index + 1
    else if (event.key === 'ArrowUp') nextIndex = index - columnCount()
    else if (event.key === 'ArrowDown') nextIndex = index + columnCount()
    else if (event.key === 'Home') nextIndex = 0
    else if (event.key === 'End') nextIndex = COMPLETION_CELEBRATION_OPTIONS.length - 1

    if (nextIndex === null) return
    event.preventDefault()
    focusAt(nextIndex)
  }
</script>

<section class="settings-section celebration-settings" aria-labelledby="celebration-settings-title">
  <div>
    <h3 id="celebration-settings-title">Day completion celebration</h3>
    <p>
      Pick a card to save it immediately. Balance will open yesterday for a read-only preview, play it for a few
      seconds, then bring you right back here. Reduced-motion mode swaps in a calm still version.
    </p>
  </div>

  <div
    class="celebration-options"
    role="group"
    aria-label="Day completion celebration"
    bind:this={grid}
  >
    {#each COMPLETION_CELEBRATION_OPTIONS as celebration, index (celebration.id)}
      <div class="celebration-option">
        <button
          type="button"
          class="celebration-option-button"
          class:selected={selectedId === celebration.id}
          aria-pressed={selectedId === celebration.id}
          tabindex={rovingId === celebration.id ? 0 : -1}
          data-celebration-option={celebration.id}
          style={`--celebration-art-a: ${celebration.palette[0]}; --celebration-art-b: ${celebration.palette[1]}; --celebration-art-c: ${celebration.palette[2]}`}
          on:focus={() => (rovingId = celebration.id)}
          on:keydown={(event) => handleGridKeydown(event, index)}
          on:click={() => onSelect(celebration.id)}
        >
          <span
            class="celebration-option-art"
            data-celebration-category={celebration.category}
            data-celebration-recipe={celebration.recipe}
            aria-hidden="true"
          >
            <span class="celebration-option-art-orbit"></span>
            <span class="celebration-option-icon">{celebration.icon}</span>
          </span>
          <span class="celebration-option-copy">
            <strong>{celebration.name}</strong>
            <small>{celebration.description}</small>
          </span>
        </button>
      </div>
    {/each}
  </div>
</section>
