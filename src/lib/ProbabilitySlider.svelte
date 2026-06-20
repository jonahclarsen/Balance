<script lang="ts">
  export let value: number
  export let min = 0
  export let max = 100
  export let step = 1
  export let ariaLabel = 'Probability'
  export let onChange: (value: number) => void

  // Position the visual thumb/fill by percentage so the handle reaches both
  // literal edges at min/max, instead of the native thumb's inset behaviour.
  $: pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0

  function handleInput(event: Event) {
    const next = Number((event.currentTarget as HTMLInputElement).value)
    onChange(Number.isFinite(next) ? next : min)
  }
</script>

<div class="probability-slider">
  <div class="track-wrap">
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
  <span class="probability-readout">{Math.round(value)}%</span>
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
</style>
