<script lang="ts">
  import OverlayModal from './OverlayModal.svelte'

  export let onClose: () => void

  const isMac = /Mac|iPhone|iPad|iPod/.test(
    (typeof navigator !== 'undefined' && (navigator.platform || navigator.userAgent)) || '',
  )

  // Each token maps to a rendered <kbd>. `mod` is the platform primary modifier
  // (⌘ on macOS, Ctrl elsewhere).
  const tokenLabels: Record<string, string> = {
    mod: isMac ? '⌘' : 'Ctrl',
    alt: isMac ? '⌥' : 'Alt',
    shift: isMac ? '⇧' : 'Shift',
    up: '↑',
    down: '↓',
    esc: 'Esc',
    enter: '↵',
    tab: 'Tab',
    del: isMac ? '⌫' : 'Del',
  }

  type Shortcut = { keys: string[]; label: string; alt?: string[] }
  type Group = { title: string; shortcuts: Shortcut[] }

  const groups: Group[] = [
    {
      title: 'General',
      shortcuts: [
        { keys: ['mod', 'K'], label: 'Open / close search' },
        { keys: ['mod', 'F'], label: 'Find in current document' },
        { keys: ['mod', 'Z'], label: 'Undo' },
        { keys: ['mod', 'shift', 'Z'], label: 'Redo', alt: ['mod', 'shift', 'C'] },
        { keys: ['mod', 'shift', 'P'], label: 'Open recovery panel' },
        { keys: ['alt', 'A'], label: 'Toggle goal rhythm' },
        { keys: ['?'], label: 'Show this shortcuts reference' },
        { keys: ['esc'], label: 'Close overlay / clear selection' },
      ],
    },
    {
      title: 'Navigate',
      shortcuts: [
        { keys: ['alt', 'C'], label: 'Search' },
        { keys: ['alt', 'T'], label: 'Open Today / jump to today' },
        { keys: ['alt', 'R'], label: 'Open Lists' },
        { keys: ['alt', 'D'], label: 'Open Day Templates' },
        { keys: ['alt', 'E'], label: 'Open List Templates' },
        { keys: ['alt', 'V'], label: 'Open Metrics' },
        { keys: ['alt', 'G'], label: 'Open Goals' },
        { keys: ['alt', 'S'], label: 'Open Settings' },
        { keys: ['alt', 'Q'], label: 'Previous day (or list template)' },
        { keys: ['alt', 'W'], label: 'Next day (or list template)' },
      ],
    },
    {
      title: 'Selecting items',
      shortcuts: [
        { keys: ['mod', 'A'], label: 'Select all items' },
        { keys: ['mod', 'shift', 'A'], label: 'Select just the focused item' },
        { keys: ['up'], label: 'Move focus above selection', alt: ['down'] },
        { keys: ['shift', 'up'], label: 'Extend selection', alt: ['shift', 'down'] },
        { keys: ['esc'], label: 'Clear selection' },
      ],
    },
    {
      title: 'Editing items',
      shortcuts: [
        { keys: ['mod', 'D'], label: 'Toggle done' },
        { keys: ['E'], label: 'Edit selected list item (overlay)' },
        { keys: ['alt', 'up'], label: 'Move item up / down', alt: ['alt', 'down'] },
        { keys: ['tab'], label: 'Indent', alt: ['shift', 'tab'] },
        { keys: ['mod', 'C'], label: 'Copy items' },
        { keys: ['mod', 'X'], label: 'Cut items' },
        { keys: ['mod', 'V'], label: 'Paste items' },
        { keys: ['del'], label: 'Delete selected items' },
      ],
    },
  ]
</script>

<OverlayModal title="Keyboard shortcuts" ariaLabel="Keyboard shortcuts" z={90} {onClose}>
  <div class="shortcuts">
    {#each groups as group}
      <section class="shortcut-group">
        <h4>{group.title}</h4>
        <dl>
          {#each group.shortcuts as shortcut}
            <div class="shortcut-row">
              <dt>{shortcut.label}</dt>
              <dd>
                <span class="combo">
                  {#each shortcut.keys as token}
                    <kbd>{tokenLabels[token] ?? token}</kbd>
                  {/each}
                </span>
                {#if shortcut.alt}
                  <span class="combo-sep">/</span>
                  <span class="combo">
                    {#each shortcut.alt as token}
                      <kbd>{tokenLabels[token] ?? token}</kbd>
                    {/each}
                  </span>
                {/if}
              </dd>
            </div>
          {/each}
        </dl>
      </section>
    {/each}
  </div>
</OverlayModal>

<style>
  .shortcuts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 22px 32px;
  }

  .shortcut-group h4 {
    margin: 0 0 10px;
    color: var(--muted);
    font-size: 12px;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  dl {
    margin: 0;
    display: grid;
    gap: 9px;
  }

  .shortcut-row {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 14px;
  }

  dt {
    min-width: 0;
    color: var(--ink);
    font-size: 13.5px;
  }

  dd {
    margin: 0;
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    gap: 5px;
  }

  .combo {
    display: inline-flex;
    gap: 3px;
  }

  .combo-sep {
    color: var(--muted);
    font-size: 12px;
  }

  kbd {
    display: inline-grid;
    place-items: center;
    min-width: 20px;
    height: 22px;
    padding: 0 6px;
    border: 1px solid var(--line-strong);
    border-bottom-width: 2px;
    border-radius: 5px;
    background: var(--paper);
    color: var(--ink);
    font-family: inherit;
    font-size: 12px;
    line-height: 1;
    white-space: nowrap;
  }
</style>
