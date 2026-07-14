<script lang="ts">
  export let value: number
  export let min = 0
  export let max = 100
  export let step = 1
  export let ariaLabel = 'Probability'
  export let onChange: (value: number) => void
  // When true the readout becomes an editable number box for typing a precise
  // percentage; otherwise it stays a plain readout.
  export let editable = false
  // Expands the transparent native control around the visible thumb while
  // keeping the slider's visual size and surrounding row spacing unchanged.
  export let generousHitbox = false

  // Position the visual thumb/fill by percentage so the handle reaches both
  // literal edges at min/max, instead of the native thumb's inset behaviour.
  $: pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0

  function clampToStep(next: number): number {
    const rounded = min + Math.round((next - min) / step) * step
    return Math.min(max, Math.max(min, rounded))
  }

  function handleInput(event: Event) {
    const next = Number((event.currentTarget as HTMLInputElement).value)
    onChange(Number.isFinite(next) ? clampToStep(next) : min)
  }

  // Commit the typed value on change/blur so intermediate keystrokes aren't
  // clamped mid-entry; revert the box if the field is left empty/invalid.
  function handleNumberChange(event: Event) {
    const input = event.currentTarget as HTMLInputElement
    const next = Number(input.value)

    if (input.value.trim() === '' || !Number.isFinite(next)) {
      input.value = String(Math.round(value))
      return
    }

    const clamped = clampToStep(next)
    input.value = String(clamped)
    onChange(clamped)
  }
</script>

<div class="probability-slider">
  <div class="track-wrap" class:generous-hitbox={generousHitbox}>
    <div class="track"></div>
    <div class="fill" style={`width: ${pct}%`}></div>
    <div class="thumb" style={`left: ${pct}%`}></div>
    <input
      class="native"
      type="range"
      {min}
      {max}
      {step}
      value={value}
      aria-label={ariaLabel}
      on:input={handleInput}
    />
  </div>
  {#if editable}
    <label class="probability-input-wrap">
      <input
        class="probability-input"
        type="number"
        {min}
        {max}
        {step}
        value={Math.round(value)}
        aria-label={`${ariaLabel} percent`}
        on:change={handleNumberChange}
      />
      <span class="probability-suffix" aria-hidden="true">%</span>
    </label>
  {:else}
    <span class="probability-readout">{Math.round(value)}%</span>
  {/if}
</div>

<style>
  .probability-slider {
    display: flex;
    align-items: center;
    gap: 6px;
    flex: 0 0 auto;
  }

  .track-wrap {
    position: relative;
    width: 96px;
    height: 16px;
    display: flex;
    align-items: center;
  }

  .track-wrap.generous-hitbox {
    height: 28px;
    margin-block: -6px;
  }

  .track {
    position: absolute;
    inset-inline: 0;
    height: 4px;
    border-radius: 999px;
    background: var(--line);
  }

  .fill {
    position: absolute;
    left: 0;
    height: 4px;
    border-radius: 999px;
    background: var(--accent);
    pointer-events: none;
  }

  .thumb {
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--accent-strong);
    border: 1px solid var(--paper-strong);
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
    transform: translate(-50%, -50%);
    pointer-events: none;
  }

  /* Transparent native input on top for interaction + accessibility. */
  .native {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    margin: 0;
    padding: 0;
    opacity: 0;
    cursor: pointer;
  }

  .probability-readout {
    width: 32px;
    text-align: right;
    color: var(--muted);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }

  .probability-input-wrap {
    display: inline-flex;
    align-items: center;
    gap: 1px;
    color: var(--muted);
    font-size: 12px;
  }

  .probability-input {
    width: 34px;
    padding: 1px 2px;
    border: 1px solid var(--line);
    border-radius: 4px;
    background: var(--paper);
    color: inherit;
    font: inherit;
    text-align: right;
    font-variant-numeric: tabular-nums;
    -moz-appearance: textfield;
    appearance: textfield;
  }

  .probability-input::-webkit-outer-spin-button,
  .probability-input::-webkit-inner-spin-button {
    -webkit-appearance: none;
    margin: 0;
  }

  .probability-input:focus-visible {
    outline: none;
    border-color: var(--accent);
  }
</style>
