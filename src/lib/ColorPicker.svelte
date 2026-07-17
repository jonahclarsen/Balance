<script lang="ts">
  import { normalizePickerHue, normalizePickerLightness, pickerColorToHex, type PickerColor } from './colors'

  export let hue: number
  export let lightness: number
  export let ariaLabel = 'Color'
  export let onChange: (color: PickerColor) => void

  $: normalizedHue = normalizePickerHue(hue)
  $: normalizedLightness = normalizePickerLightness(lightness)
  $: thumbX = (normalizedHue / 359) * 100
  $: thumbY = 100 - normalizedLightness

  function updateFromPointer(event: PointerEvent) {
    const picker = event.currentTarget as HTMLButtonElement
    const bounds = picker.getBoundingClientRect()
    const x = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width))
    const y = Math.max(0, Math.min(1, (event.clientY - bounds.top) / bounds.height))

    onChange({
      hue: Math.round(x * 359),
      lightness: Math.round((1 - y) * 100),
    })
  }

  function handlePointerDown(event: PointerEvent) {
    if (event.button !== 0) return

    const picker = event.currentTarget as HTMLButtonElement
    picker.setPointerCapture(event.pointerId)
    picker.focus()
    updateFromPointer(event)
  }

  function handlePointerMove(event: PointerEvent) {
    const picker = event.currentTarget as HTMLButtonElement
    if (!picker.hasPointerCapture(event.pointerId)) return
    updateFromPointer(event)
  }

  function handleKeydown(event: KeyboardEvent) {
    const step = event.shiftKey ? 10 : 1
    let nextHue = normalizedHue
    let nextLightness = normalizedLightness

    if (event.key === 'ArrowLeft') nextHue = Math.max(0, normalizedHue - step)
    else if (event.key === 'ArrowRight') nextHue = Math.min(359, normalizedHue + step)
    else if (event.key === 'ArrowUp') nextLightness = Math.min(100, normalizedLightness + step)
    else if (event.key === 'ArrowDown') nextLightness = Math.max(0, normalizedLightness - step)
    else return

    event.preventDefault()
    event.stopPropagation()
    onChange({ hue: nextHue, lightness: nextLightness })
  }
</script>

<button
  type="button"
  class="color-picker"
  aria-label={ariaLabel}
  title={`Hue ${normalizedHue}°, lightness ${normalizedLightness}%. Use left and right for hue; up and down for lightness.`}
  on:pointerdown={handlePointerDown}
  on:pointermove={handlePointerMove}
  on:keydown={handleKeydown}
>
  <span
    class="color-picker-thumb"
    style={`left: clamp(8px, ${thumbX}%, calc(100% - 8px)); top: clamp(8px, ${thumbY}%, calc(100% - 8px)); background: ${pickerColorToHex({ hue: normalizedHue, lightness: normalizedLightness })}`}
  ></span>
</button>

<style>
  .color-picker {
    appearance: none;
    position: relative;
    display: block;
    width: 100%;
    min-width: 150px;
    height: 64px;
    padding: 0;
    overflow: hidden;
    border: 1px solid var(--line-strong);
    border-radius: 7px;
    background:
      linear-gradient(to bottom, rgba(255, 255, 255, 0.68), transparent 48%, rgba(0, 0, 0, 0.56)),
      linear-gradient(
        to right,
        hsl(0 70% 50%),
        hsl(60 70% 50%),
        hsl(120 70% 50%),
        hsl(180 70% 50%),
        hsl(240 70% 50%),
        hsl(300 70% 50%),
        hsl(360 70% 50%)
      );
    box-shadow: inset 0 0 0 1px rgb(255 255 255 / 0.15);
    cursor: crosshair;
    touch-action: none;
    transition: filter 120ms ease;
  }

  .color-picker:hover {
    filter: brightness(0.97);
  }

  .color-picker:focus-visible {
    outline: 2px solid var(--focus-ring);
    outline-offset: 2px;
  }

  .color-picker-thumb {
    position: absolute;
    width: 16px;
    height: 16px;
    border: 2px solid white;
    border-radius: 50%;
    box-shadow: 0 0 0 1px rgb(0 0 0 / 0.58), 0 1px 3px rgb(0 0 0 / 0.45);
    pointer-events: none;
    transform: translate(-50%, -50%);
  }
</style>
