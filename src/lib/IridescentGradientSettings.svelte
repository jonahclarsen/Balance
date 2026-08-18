<script lang="ts">
  import { onDestroy } from 'svelte'
  import type { IridescentGradientColor, IridescentGradientPreferences } from './types'

  export let value: IridescentGradientPreferences
  export let defaults: IridescentGradientPreferences
  export let onPreview: (value: IridescentGradientPreferences) => void
  export let onCommit: (value: IridescentGradientPreferences) => void

  const colorNames = ['Magenta', 'Aqua', 'Gold'] as const
  let commitTimer: number | null = null
  let gradientBeforeRestore: IridescentGradientPreferences | null = null

  $: isDefault = JSON.stringify(value) === JSON.stringify(defaults)
  $: canRestorePreviousGradient = isDefault && gradientBeforeRestore !== null
  $: previewStyle = value.colors.map((color, index) => {
    const alpha = Math.min(1, color.strength / 100 * value.contrast / 100)
    return `--preview-color-${index + 1}: hsl(${color.hue} ${color.saturation}% ${color.lightness}% / ${alpha})`
  }).join('; ')

  onDestroy(() => {
    if (commitTimer !== null) window.clearTimeout(commitTimer)
  })

  function publish(next: IridescentGradientPreferences, commit: boolean) {
    onPreview(next)
    if (commitTimer !== null) window.clearTimeout(commitTimer)
    if (commit) {
      commitTimer = null
      onCommit(next)
      return
    }
    commitTimer = window.setTimeout(() => {
      commitTimer = null
      onCommit(next)
    }, 250)
  }

  function updateGlobal(
    key: Exclude<keyof IridescentGradientPreferences, 'colors'>,
    nextValue: number,
    commit: boolean,
  ) {
    const next = { ...value, [key]: nextValue }
    publish(next, commit)
  }

  function updateColor(
    index: number,
    key: keyof IridescentGradientColor,
    nextValue: number,
    commit: boolean,
  ) {
    const colors = value.colors.map((color, colorIndex) =>
      colorIndex === index ? { ...color, [key]: nextValue } : color,
    ) as IridescentGradientPreferences['colors']
    const next = { ...value, colors }
    publish(next, commit)
  }

  function hslToHex(color: IridescentGradientColor): string {
    const saturation = color.saturation / 100
    const lightness = color.lightness / 100
    const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation
    const segment = color.hue / 60
    const secondary = chroma * (1 - Math.abs(segment % 2 - 1))
    const [red, green, blue] = segment < 1 ? [chroma, secondary, 0]
      : segment < 2 ? [secondary, chroma, 0]
        : segment < 3 ? [0, chroma, secondary]
          : segment < 4 ? [0, secondary, chroma]
            : segment < 5 ? [secondary, 0, chroma]
              : [chroma, 0, secondary]
    const match = lightness - chroma / 2
    return `#${[red, green, blue]
      .map((channel) => Math.round((channel + match) * 255).toString(16).padStart(2, '0'))
      .join('')}`
  }

  function hexToHsl(hex: string): Pick<IridescentGradientColor, 'hue' | 'saturation' | 'lightness'> {
    const [red, green, blue] = [1, 3, 5].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16) / 255)
    const max = Math.max(red, green, blue)
    const min = Math.min(red, green, blue)
    const delta = max - min
    const lightness = (max + min) / 2
    let hue = 0
    if (delta > 0) {
      if (max === red) hue = 60 * (((green - blue) / delta) % 6)
      else if (max === green) hue = 60 * ((blue - red) / delta + 2)
      else hue = 60 * ((red - green) / delta + 4)
    }
    const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1))
    return {
      hue: Math.round((hue + 360) % 360),
      saturation: Math.round(saturation * 100),
      lightness: Math.round(lightness * 100),
    }
  }

  function updateColorFromHex(index: number, hex: string, commit: boolean) {
    const hsl = hexToHsl(hex)
    const colors = value.colors.map((color, colorIndex) =>
      colorIndex === index ? { ...color, ...hsl } : color,
    ) as IridescentGradientPreferences['colors']
    const next = { ...value, colors }
    publish(next, commit)
  }

  function cloneGradient(gradient: IridescentGradientPreferences): IridescentGradientPreferences {
    return {
      ...gradient,
      colors: gradient.colors.map((color) => ({ ...color })) as IridescentGradientPreferences['colors'],
    }
  }

  function toggleOriginalGradient() {
    if (canRestorePreviousGradient && gradientBeforeRestore) {
      publish(cloneGradient(gradientBeforeRestore), true)
      return
    }

    gradientBeforeRestore = cloneGradient(value)
    publish(cloneGradient(defaults), true)
  }
</script>

<div class="iridescent-gradient-settings" aria-label="Iridescent background controls">
  <div class="iridescent-gradient-heading">
    <div>
      <span class="iridescent-kicker">Gradient studio</span>
      <h4>Shape the atmosphere</h4>
      <p>Every adjustment previews immediately across the full background.</p>
    </div>
    <span class="iridescent-live-badge"><i></i>Live</span>
  </div>

  <div
    class="iridescent-gradient-preview"
    style={`${previewStyle}; --preview-angle: ${value.angle}deg; --preview-reach: ${value.reach}%`}
    aria-hidden="true"
  >
    <span>Balance</span>
    <small>Your custom iridescent atmosphere</small>
  </div>

  <div class="iridescent-control-group">
    <div class="iridescent-control-group-heading">
      <strong>Overall blend</strong>
      <span>Set the backdrop before fine-tuning each color.</span>
    </div>
    <div class="iridescent-global-grid">
      <label class="iridescent-gradient-control">
        <span><strong>Contrast</strong><output>{value.contrast}%</output></span>
        <small>Separation between the color washes and backdrop</small>
        <input
          type="range"
          min="0"
          max="250"
          value={value.contrast}
          aria-label="Iridescent contrast"
          on:input={(event) => updateGlobal('contrast', Number(event.currentTarget.value), false)}
          on:change={(event) => updateGlobal('contrast', Number(event.currentTarget.value), true)}
        />
      </label>

      <label class="iridescent-gradient-control">
        <span><strong>Backdrop saturation</strong><output>{value.backgroundSaturation}%</output></span>
        <small>Colorfulness of the quiet layer underneath</small>
        <input
          type="range"
          min="0"
          max="200"
          value={value.backgroundSaturation}
          aria-label="Iridescent backdrop saturation"
          on:input={(event) => updateGlobal('backgroundSaturation', Number(event.currentTarget.value), false)}
          on:change={(event) => updateGlobal('backgroundSaturation', Number(event.currentTarget.value), true)}
        />
      </label>

      <label class="iridescent-gradient-control">
        <span><strong>Backdrop lightness</strong><output>{value.backgroundLightness > 0 ? '+' : ''}{value.backgroundLightness}</output></span>
        <small>Shift both the light and dark appearances</small>
        <input
          type="range"
          min="-12"
          max="12"
          value={value.backgroundLightness}
          aria-label="Iridescent backdrop lightness"
          on:input={(event) => updateGlobal('backgroundLightness', Number(event.currentTarget.value), false)}
          on:change={(event) => updateGlobal('backgroundLightness', Number(event.currentTarget.value), true)}
        />
      </label>

      <label class="iridescent-gradient-control">
        <span><strong>Direction</strong><output>{value.angle}°</output></span>
        <small>Angle of the underlying directional gradient</small>
        <input
          type="range"
          min="0"
          max="360"
          value={value.angle}
          aria-label="Iridescent gradient direction"
          on:input={(event) => updateGlobal('angle', Number(event.currentTarget.value), false)}
          on:change={(event) => updateGlobal('angle', Number(event.currentTarget.value), true)}
        />
      </label>

      <label class="iridescent-gradient-control">
        <span><strong>Color reach</strong><output>{value.reach}%</output></span>
        <small>How far each wash travels before fading away</small>
        <input
          type="range"
          min="16"
          max="70"
          value={value.reach}
          aria-label="Iridescent color reach"
          on:input={(event) => updateGlobal('reach', Number(event.currentTarget.value), false)}
          on:change={(event) => updateGlobal('reach', Number(event.currentTarget.value), true)}
        />
      </label>
    </div>
  </div>

  <div class="iridescent-control-group">
    <div class="iridescent-control-group-heading">
      <strong>Color washes</strong>
      <span>Mix any hues you like, then balance their individual intensity.</span>
    </div>
    <div class="iridescent-color-grid">
      {#each value.colors as color, index}
        <article class="iridescent-color-card" style={`--editor-hue: ${color.hue}`}>
          <header>
            <span class="iridescent-color-number">0{index + 1}</span>
            <div>
              <strong>{colorNames[index]}</strong>
              <small>Color source</small>
            </div>
            <input
              class="iridescent-color-well"
              type="color"
              value={hslToHex(color)}
              aria-label={`${colorNames[index]} color`}
              on:input={(event) => updateColorFromHex(index, event.currentTarget.value, false)}
              on:change={(event) => updateColorFromHex(index, event.currentTarget.value, true)}
            />
          </header>

          <label class="iridescent-gradient-control compact">
            <span><strong>Hue</strong><output>{color.hue}°</output></span>
            <input
              class="hue-track"
              type="range"
              min="0"
              max="360"
              value={color.hue}
              aria-label={`${colorNames[index]} hue`}
              on:input={(event) => updateColor(index, 'hue', Number(event.currentTarget.value), false)}
              on:change={(event) => updateColor(index, 'hue', Number(event.currentTarget.value), true)}
            />
          </label>

          <label class="iridescent-gradient-control compact">
            <span><strong>Saturation</strong><output>{color.saturation}%</output></span>
            <input
              class="saturation-track"
              type="range"
              min="0"
              max="100"
              value={color.saturation}
              aria-label={`${colorNames[index]} saturation`}
              on:input={(event) => updateColor(index, 'saturation', Number(event.currentTarget.value), false)}
              on:change={(event) => updateColor(index, 'saturation', Number(event.currentTarget.value), true)}
            />
          </label>

          <label class="iridescent-gradient-control compact">
            <span><strong>Lightness</strong><output>{color.lightness}%</output></span>
            <input
              class="lightness-track"
              type="range"
              min="0"
              max="100"
              value={color.lightness}
              aria-label={`${colorNames[index]} lightness`}
              on:input={(event) => updateColor(index, 'lightness', Number(event.currentTarget.value), false)}
              on:change={(event) => updateColor(index, 'lightness', Number(event.currentTarget.value), true)}
            />
          </label>

          <label class="iridescent-gradient-control compact">
            <span><strong>Strength</strong><output>{color.strength}%</output></span>
            <input
              class="strength-track"
              type="range"
              min="0"
              max="40"
              value={color.strength}
              aria-label={`${colorNames[index]} strength`}
              on:input={(event) => updateColor(index, 'strength', Number(event.currentTarget.value), false)}
              on:change={(event) => updateColor(index, 'strength', Number(event.currentTarget.value), true)}
            />
          </label>
        </article>
      {/each}
    </div>
  </div>

  <div class="iridescent-gradient-actions">
    <p>Adjustments are saved automatically and follow this theme between devices.</p>
    <button
      type="button"
      disabled={isDefault && !canRestorePreviousGradient}
      on:click={toggleOriginalGradient}
    >{canRestorePreviousGradient ? 'Return to your gradient' : 'Restore original gradient'}</button>
  </div>
</div>

<style>
  .iridescent-gradient-settings {
    display: grid;
    gap: 18px;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--line));
    border-radius: 14px;
    background: color-mix(in srgb, var(--paper-strong) 95%, var(--accent));
    padding: 18px;
    box-shadow: inset 0 1px rgb(255 255 255 / 0.2);
  }

  .iridescent-gradient-heading,
  .iridescent-gradient-actions,
  .iridescent-color-card header,
  .iridescent-gradient-control > span {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .iridescent-gradient-heading {
    align-items: start;
  }

  .iridescent-gradient-heading > div,
  .iridescent-control-group,
  .iridescent-control-group-heading,
  .iridescent-color-card header > div {
    display: grid;
  }

  .iridescent-gradient-heading > div {
    gap: 3px;
  }

  .iridescent-kicker {
    color: var(--accent-strong);
    font-size: 10px;
    font-weight: 850;
    letter-spacing: 0.12em;
    text-transform: uppercase;
  }

  h4 {
    margin: 0;
    color: var(--ink);
    font-size: 19px;
  }

  .iridescent-gradient-heading p,
  .iridescent-gradient-actions p {
    margin: 0;
    color: var(--muted);
    font-size: 11px;
    line-height: 1.4;
  }

  .iridescent-live-badge {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border: 1px solid color-mix(in srgb, var(--theme-done) 45%, var(--line));
    border-radius: 999px;
    background: color-mix(in srgb, var(--theme-done) 9%, var(--paper-strong));
    padding: 5px 9px;
    color: color-mix(in srgb, var(--theme-done) 80%, var(--ink));
    font-size: 10px;
    font-weight: 800;
  }

  .iridescent-live-badge i {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--theme-done);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--theme-done) 16%, transparent);
  }

  .iridescent-gradient-preview {
    position: relative;
    display: grid;
    min-height: 124px;
    align-content: end;
    gap: 2px;
    overflow: hidden;
    border: 1px solid rgb(255 255 255 / 0.46);
    border-radius: 12px;
    background:
      radial-gradient(circle at 10% 16%, var(--preview-color-1), transparent var(--preview-reach)),
      radial-gradient(circle at 88% 12%, var(--preview-color-2), transparent var(--preview-reach)),
      radial-gradient(circle at 72% 92%, var(--preview-color-3), transparent var(--preview-reach)),
      linear-gradient(var(--preview-angle), var(--paper-strong), color-mix(in srgb, var(--paper-strong) 82%, var(--accent)));
    padding: 16px;
    box-shadow: inset 0 0 30px rgb(255 255 255 / 0.18), 0 7px 20px rgb(35 25 48 / 0.08);
    isolation: isolate;
  }

  .iridescent-gradient-preview::after {
    position: absolute;
    inset: 0;
    border-radius: inherit;
    background: linear-gradient(180deg, transparent 35%, rgb(20 15 25 / 0.14));
    content: '';
    z-index: -1;
  }

  .iridescent-gradient-preview span {
    color: color-mix(in srgb, var(--ink) 92%, white);
    font-size: 18px;
    font-weight: 850;
    text-shadow: 0 1px 8px rgb(255 255 255 / 0.35);
  }

  .iridescent-gradient-preview small {
    color: color-mix(in srgb, var(--ink) 68%, transparent);
    font-size: 10px;
    font-weight: 650;
  }

  .iridescent-control-group {
    gap: 11px;
    border-top: 1px solid color-mix(in srgb, var(--line) 76%, transparent);
    padding-top: 17px;
  }

  .iridescent-control-group-heading {
    gap: 2px;
  }

  .iridescent-control-group-heading strong {
    font-size: 12px;
  }

  .iridescent-control-group-heading span {
    color: var(--muted);
    font-size: 10px;
  }

  .iridescent-global-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 9px;
  }

  .iridescent-gradient-control {
    display: grid;
    align-content: start;
    gap: 6px;
    min-width: 0;
    border: 1px solid color-mix(in srgb, var(--line) 82%, transparent);
    border-radius: 9px;
    background: color-mix(in srgb, var(--paper-strong) 94%, transparent);
    padding: 10px;
  }

  .iridescent-gradient-control.compact {
    gap: 5px;
    border: 0;
    border-radius: 0;
    background: transparent;
    padding: 0;
  }

  .iridescent-gradient-control strong {
    color: var(--ink);
    font-size: 10px;
    font-weight: 750;
  }

  .iridescent-gradient-control output {
    min-width: 34px;
    color: var(--accent-strong);
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 800;
    text-align: right;
  }

  .iridescent-gradient-control small {
    min-height: 26px;
    color: var(--muted);
    font-size: 9px;
    line-height: 1.4;
  }

  .iridescent-gradient-control input[type='range'] {
    width: 100%;
    height: 5px;
    margin: 4px 0 2px;
    appearance: none;
    border: 0;
    border-radius: 999px;
    outline: none;
    background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 18%, var(--line)), var(--accent));
    padding: 0;
  }

  .iridescent-gradient-control input[type='range']::-webkit-slider-thumb {
    width: 15px;
    height: 15px;
    appearance: none;
    border: 2px solid var(--paper-strong);
    border-radius: 50%;
    background: var(--accent-strong);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.24), 0 0 0 1px color-mix(in srgb, var(--accent-strong) 55%, transparent);
    cursor: ew-resize;
  }

  .iridescent-gradient-control input[type='range']::-moz-range-thumb {
    width: 12px;
    height: 12px;
    border: 2px solid var(--paper-strong);
    border-radius: 50%;
    background: var(--accent-strong);
    box-shadow: 0 1px 4px rgb(0 0 0 / 0.24);
    cursor: ew-resize;
  }

  .iridescent-color-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 9px;
  }

  .iridescent-color-card {
    display: grid;
    gap: 13px;
    min-width: 0;
    border: 1px solid color-mix(in srgb, hsl(var(--editor-hue) 70% 55%) 30%, var(--line));
    border-radius: 11px;
    background: linear-gradient(160deg, color-mix(in srgb, hsl(var(--editor-hue) 70% 55%) 8%, var(--paper-strong)), var(--paper-strong) 44%);
    padding: 11px;
    box-shadow: 0 3px 12px rgb(30 20 42 / 0.04);
  }

  .iridescent-color-card header {
    justify-content: start;
  }

  .iridescent-color-number {
    color: color-mix(in srgb, hsl(var(--editor-hue) 75% 55%) 75%, var(--ink));
    font-family: var(--font-mono);
    font-size: 9px;
    font-weight: 850;
  }

  .iridescent-color-card header > div {
    flex: 1;
    gap: 1px;
  }

  .iridescent-color-card header strong {
    font-size: 11px;
  }

  .iridescent-color-card header small {
    color: var(--muted);
    font-size: 8px;
  }

  .iridescent-color-well {
    width: 28px;
    height: 28px;
    overflow: hidden;
    border: 2px solid var(--paper-strong);
    border-radius: 50%;
    background: transparent;
    padding: 0;
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 16%, transparent), 0 2px 5px rgb(0 0 0 / 0.16);
    cursor: pointer;
  }

  .iridescent-color-well::-webkit-color-swatch-wrapper {
    padding: 0;
  }

  .iridescent-color-well::-webkit-color-swatch {
    border: 0;
    border-radius: 50%;
  }

  .iridescent-gradient-control .hue-track {
    background: linear-gradient(90deg, #f44, #ffef44, #4fdc71, #45dbea, #5969ee, #ca50e8, #f44);
  }

  .iridescent-gradient-control .saturation-track {
    background: linear-gradient(90deg, hsl(var(--editor-hue) 0% 58%), hsl(var(--editor-hue) 100% 55%));
  }

  .iridescent-gradient-control .lightness-track {
    background: linear-gradient(90deg, #080808, hsl(var(--editor-hue) 80% 50%), #fff);
  }

  .iridescent-gradient-control .strength-track {
    background: linear-gradient(90deg, transparent, hsl(var(--editor-hue) 80% 55%));
  }

  .iridescent-gradient-actions {
    align-items: center;
    border-top: 1px solid color-mix(in srgb, var(--line) 76%, transparent);
    padding-top: 15px;
  }

  .iridescent-gradient-actions p {
    max-width: 360px;
  }

  .iridescent-gradient-actions button {
    flex: 0 0 auto;
    border-color: color-mix(in srgb, var(--accent) 46%, var(--line));
    background: color-mix(in srgb, var(--paper-strong) 92%, var(--accent));
    font-size: 10px;
    font-weight: 750;
  }

  @media (max-width: 760px) {
    .iridescent-color-grid {
      grid-template-columns: 1fr;
    }

    .iridescent-color-card {
      grid-template-columns: minmax(120px, 0.8fr) repeat(2, minmax(0, 1fr));
      align-items: center;
    }

    .iridescent-color-card header {
      grid-row: span 2;
    }
  }

  @media (max-width: 520px) {
    .iridescent-gradient-settings {
      padding: 14px;
    }

    .iridescent-global-grid,
    .iridescent-color-card {
      grid-template-columns: 1fr;
    }

    .iridescent-color-card header {
      grid-row: auto;
    }

    .iridescent-gradient-actions {
      align-items: stretch;
      flex-direction: column;
    }

    .iridescent-gradient-actions button {
      width: 100%;
    }
  }
</style>
