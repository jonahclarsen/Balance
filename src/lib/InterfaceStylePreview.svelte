<script lang="ts">
  import type { InterfaceStylePreference } from './types'

  export let interfaceStyle: InterfaceStylePreference

  const navRows = [
    { label: 'Today', key: 'T' },
    { label: 'Days', key: 'D' },
    { label: 'Lists', key: 'E' },
    { label: 'Notes', key: 'N' },
  ]
</script>

<!-- A miniature of the sidebar and day header, drawn in a fixed style so each
     option shows its own look whichever style is active. -->
<span class="preview" class:classic={interfaceStyle === 'classic'} aria-hidden="true">
  <span class="preview-sidebar">
    <span class="preview-brand">Balance</span>
    <span class="preview-nav">
      {#each navRows as row, index (row.label)}
        <span class="preview-nav-row" class:active={index === 0}>
          <span>{row.label}</span>
          <span class="preview-key">{row.key}</span>
        </span>
      {/each}
    </span>
  </span>
  <span class="preview-main">
    <span class="preview-eyebrow">Today</span>
    <span class="preview-title">
      Friday
      <span class="preview-reminder">{interfaceStyle === 'classic' ? '— ' : ''}Go gently</span>
    </span>
    <span class="preview-panel">
      <span class="preview-task done"><span class="preview-check"></span><span class="preview-line"></span></span>
      <span class="preview-task"><span class="preview-check"></span><span class="preview-line short"></span></span>
    </span>
  </span>
</span>

<style>
  .preview {
    --preview-font: "Geist", ui-sans-serif, -apple-system, "Segoe UI", sans-serif;
    --preview-mono: "Geist Mono", "SFMono-Regular", Menlo, monospace;
    display: grid;
    grid-column: 1 / -1;
    grid-template-columns: 38% minmax(0, 1fr);
    height: 112px;
    overflow: hidden;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--app-background);
    color: var(--ink);
    font-family: var(--preview-font);
    font-size: 8px;
    font-weight: 450;
    letter-spacing: -0.006em;
    line-height: 1.2;
    text-align: left;
    pointer-events: none;
  }

  .preview.classic {
    --preview-font: ui-rounded, "SF Pro Rounded", "Arial Rounded MT Bold", sans-serif;
    --preview-mono: inherit;
    font-weight: normal;
    letter-spacing: normal;
  }

  .preview-brand,
  .preview-eyebrow,
  .preview-title,
  .preview-reminder,
  .preview-key,
  .preview-check,
  .preview-line {
    display: block;
  }

  .preview-sidebar {
    display: grid;
    align-content: start;
    gap: 6px;
    padding: 8px 6px;
    border-right: 1px solid color-mix(in srgb, var(--line) 70%, transparent);
    background: var(--sidebar);
  }

  .classic .preview-sidebar {
    gap: 8px;
    border-right-color: var(--line);
  }

  .preview-brand {
    font-family: 'Sora', var(--preview-font);
    font-size: 11px;
    font-weight: 700;
    letter-spacing: -0.035em;
  }

  .classic .preview-brand {
    font-size: 13px;
    letter-spacing: normal;
  }

  .preview-nav {
    display: grid;
    gap: 1px;
  }

  .classic .preview-nav {
    gap: 3px;
  }

  .preview-nav-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    min-height: 13px;
    padding: 1px 4px;
    border: 1px solid transparent;
    border-bottom-color: color-mix(in srgb, var(--line) 75%, transparent);
    border-radius: 4px;
    color: color-mix(in srgb, var(--ink) 78%, var(--muted));
    font-weight: 500;
  }

  .preview-nav-row:last-child {
    border-bottom-color: transparent;
  }

  .preview-nav-row.active {
    border-color: transparent;
    background: color-mix(in srgb, var(--paper-strong) 82%, transparent);
    box-shadow: 0 0 0 1px color-mix(in srgb, var(--line) 70%, transparent), 0 1px 2px rgb(0 0 0 / 0.05);
    color: var(--accent-strong);
    font-weight: 600;
  }

  .classic .preview-nav-row {
    border-color: var(--line);
    border-radius: 3px;
    background: var(--paper-strong);
    color: var(--ink);
  }

  .classic .preview-nav-row.active {
    border-color: var(--accent);
    background: var(--active-nav);
    box-shadow: none;
    color: var(--accent-strong);
    font-weight: 500;
  }

  .preview-key {
    color: var(--muted);
    font-family: var(--preview-mono);
    font-size: 6px;
    opacity: 0.55;
  }

  .preview-nav-row.active .preview-key {
    color: inherit;
    opacity: 1;
  }

  .classic .preview-key {
    min-width: 9px;
    border: 1px solid var(--line);
    border-bottom-color: var(--line-strong);
    border-radius: 2px;
    font-weight: 700;
    line-height: 7px;
    text-align: center;
    opacity: 1;
  }

  .preview-main {
    display: grid;
    align-content: start;
    gap: 2px;
    min-width: 0;
    padding: 9px 9px 0;
  }

  .preview-eyebrow {
    color: var(--accent-strong);
    font-size: 7px;
    font-weight: 600;
  }

  .classic .preview-eyebrow {
    font-size: 6px;
    font-weight: 700;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }

  .preview-title {
    overflow: hidden;
    font-size: 13px;
    font-weight: 650;
    letter-spacing: -0.032em;
    white-space: nowrap;
  }

  .preview-reminder {
    margin-top: 2px;
    color: var(--muted);
    font-size: 8px;
    font-weight: 450;
    letter-spacing: -0.01em;
  }

  .classic .preview-title {
    font-weight: bold;
    letter-spacing: normal;
  }

  .classic .preview-reminder {
    display: inline;
    margin-top: 0;
    font-size: inherit;
    font-weight: 500;
    letter-spacing: normal;
  }

  .preview-panel {
    display: grid;
    gap: 5px;
    margin-top: 5px;
    padding: 6px;
    border: 1px solid color-mix(in srgb, var(--line) 82%, transparent);
    border-radius: 6px;
    background: var(--paper);
    box-shadow: 0 1px 2px rgb(29 36 40 / 0.04), 0 6px 14px -9px rgb(29 36 40 / 0.18);
  }

  .classic .preview-panel {
    border-color: var(--line);
    border-radius: 4px;
    box-shadow: 0 6px 14px rgb(38 35 27 / 0.09);
  }

  .preview-task {
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .preview-check {
    flex: none;
    width: 7px;
    height: 7px;
    border: 1px solid color-mix(in srgb, var(--line-strong) 85%, var(--muted));
    border-radius: 2px;
    background: var(--paper-strong);
  }

  .classic .preview-check {
    border-color: var(--line-strong);
    border-radius: 1.5px;
  }

  .preview-task.done .preview-check {
    border-color: var(--checkbox-checked);
    background: var(--checkbox-checked);
  }

  .preview-line {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--ink) 22%, transparent);
  }

  .preview-line.short {
    flex: 0 1 62%;
  }

  .preview-task.done .preview-line {
    background: color-mix(in srgb, var(--muted) 30%, transparent);
  }
</style>
