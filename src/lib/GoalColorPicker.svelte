<script lang="ts">
  import ColorPicker from './ColorPicker.svelte'
  import { normalizePickerHue, normalizePickerLightness, pickerColorToHex, type PickerColor } from './colors'

  export let hue: number
  export let lightness: number
  export let ariaLabel: string
  export let mobile = false
  export let onChange: (color: PickerColor) => void

  let editing = false
  let draftHue = hue
  let draftLightness = lightness

  $: if (!editing) {
    draftHue = normalizePickerHue(hue)
    draftLightness = normalizePickerLightness(lightness)
  }

  function openPicker() {
    draftHue = normalizePickerHue(hue)
    draftLightness = normalizePickerLightness(lightness)
    editing = true
  }

  function cancel() {
    editing = false
  }

  function save() {
    onChange({ hue: draftHue, lightness: draftLightness })
    editing = false
  }
</script>

{#if mobile}
  <button
    class="goal-color-trigger"
    type="button"
    aria-label={ariaLabel}
    aria-expanded={editing}
    on:click={openPicker}
  >
    <span
      class="goal-color-swatch"
      style={`--goal-color: ${pickerColorToHex({ hue: normalizePickerHue(hue), lightness: normalizePickerLightness(lightness) })}`}
      aria-hidden="true"
    ></span>
    <span>{editing ? 'Choosing color…' : 'Change color'}</span>
  </button>

  {#if editing}
    <div class="mobile-goal-color-editor">
      <ColorPicker
        hue={draftHue}
        lightness={draftLightness}
        ariaLabel={`${ariaLabel} picker`}
        onChange={(color) => {
          draftHue = color.hue
          draftLightness = color.lightness
        }}
      />
      <div class="mobile-goal-color-actions">
        <button type="button" on:click={cancel}>Cancel</button>
        <button class="primary" type="button" on:click={save}>Save color</button>
      </div>
    </div>
  {/if}
{:else}
  <ColorPicker {hue} {lightness} {ariaLabel} {onChange} />
{/if}

<style>
  .goal-color-trigger {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-height: 44px;
    text-align: left;
  }

  .goal-color-swatch {
    width: 24px;
    height: 24px;
    flex: 0 0 auto;
    border: 2px solid var(--paper-strong);
    border-radius: 50%;
    background: var(--goal-color);
    box-shadow: 0 0 0 1px var(--line-strong);
  }

  .mobile-goal-color-editor {
    display: grid;
    gap: 8px;
  }

  .mobile-goal-color-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
