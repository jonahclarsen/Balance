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
    altOrMod: isMac ? '⌥ / ⌘' : 'Alt / Ctrl',
    shift: isMac ? '⇧' : 'Shift',
    up: '↑',
    down: '↓',
    left: '←',
    right: '→',
    esc: 'Esc',
    enter: '↵',
    tab: 'Tab',
    del: isMac ? '⌫' : 'Del',
  }

  type Shortcut = { keys: string[]; label: string; alt?: string[] }
  type Group = { title: string; shortcuts: Shortcut[] }

  const groups: Group[] = [
    { title: 'Images', shortcuts: [
      { keys: ['enter'], label: 'Paste current compression preview' },
      { keys: ['mod', 'enter'], label: 'Paste original image (in compression dialog)' },
      { keys: ['esc'], label: 'Close image viewer / cancel image paste' },
    ] },
    {
      title: 'General',
      shortcuts: [
        { keys: ['mod', 'K'], label: 'Open / close search' },
        { keys: ['mod', 'F'], label: 'Find in current document / search goals' },
        { keys: ['mod', 'S'], label: 'Open Goal Stats (while in Goals)' },
        { keys: ['mod', 'Z'], label: 'Undo and reveal change' },
        { keys: ['mod', 'shift', 'Z'], label: 'Redo and reveal change', alt: ['mod', 'shift', 'C'] },
        { keys: ['mod', 'shift', 'P'], label: 'Open recovery panel' },
        { keys: ['esc'], label: 'Close backup browser (workspace shortcuts pause while browsing)' },
        { keys: ['mod', 'shift', 'G'], label: 'Generate selected day' },
        { keys: ['mod', 'N'], label: 'Create note (while in Notes)' },
        { keys: ['alt', 'A'], label: 'Toggle goal rhythm' },
        { keys: ['alt', 'I'], label: 'Toggle IMAX mode' },
        { keys: ['?'], label: 'Show this shortcuts reference' },
        { keys: ['esc'], label: 'Close overlay / clear selection' },
      ],
    },
    {
      title: 'Navigate',
      shortcuts: [
        { keys: ['alt', 'C'], label: 'Search' },
        { keys: ['alt', 'T'], label: 'Open Today; press again to jump to today' },
        { keys: ['alt', 'R'], label: 'Open List History' },
        { keys: ['alt', 'N'], label: 'Open Notes' },
        { keys: ['alt', 'D'], label: 'Open Day Templates' },
        { keys: ['alt', 'E'], label: 'Open Lists' },
        { keys: ['alt', 'V'], label: 'Open Metrics' },
        { keys: ['alt', 'G'], label: 'Open Goals' },
        { keys: ['alt', 'S'], label: 'Open Settings' },
        { keys: ['alt', 'Q'], label: 'Previous day, template, or metric' },
        { keys: ['alt', 'W'], label: 'Next day, template, or metric' },
        { keys: ['alt', 'B'], label: 'Show two days side by side' },
      ],
    },
    {
      title: 'Selecting items',
      shortcuts: [
        { keys: ['mod', 'A'], label: 'Select all items' },
        { keys: ['mod', 'shift', 'A'], label: 'Select focused item, then all items' },
        { keys: ['up'], label: 'Edit selection from start', alt: ['left'] },
        { keys: ['down'], label: 'Edit selection from end', alt: ['right'] },
        { keys: ['shift', 'up'], label: 'Extend selection', alt: ['shift', 'down'] },
        { keys: ['mod', 'shift', 'up'], label: 'Directly select / extend items', alt: ['mod', 'shift', 'down'] },
        { keys: ['esc'], label: 'Clear selection' },
      ],
    },
    {
      title: 'Editing items',
      shortcuts: [
        { keys: ['mod', 'D'], label: 'Toggle done (keeps selected items selected)' },
        { keys: ['alt', 'F'], label: 'Open linked list / URL / metric' },
        { keys: ['E'], label: 'Edit selected list item (overlay)' },
        { keys: ['T'], label: 'Add / remove time from selected items' },
        { keys: ['['], label: 'Move selected start earlier / later', alt: [']'] },
        { keys: ['shift', '['], label: 'Move selected end earlier / later', alt: ['shift', ']'] },
        { keys: ['alt', 'shift', 'T'], label: 'Add / remove task time' },
        { keys: ['alt', '['], label: 'Move task start earlier / later', alt: ['alt', ']'] },
        { keys: ['mod', '['], label: 'Move task end earlier / later', alt: ['mod', ']'] },
        { keys: ['altOrMod', 'shift', '[ / ]'], label: 'Shift task time earlier / later' },
        { keys: ['alt', 'up'], label: 'Move item; hold to repeat (↑ pauses once before checked)', alt: ['alt', 'down'] },
        { keys: ['tab'], label: 'Indent', alt: ['shift', 'tab'] },
        { keys: ['mod', 'C'], label: 'Copy items' },
        { keys: ['mod', 'X'], label: 'Cut items' },
        { keys: ['mod', 'V'], label: 'Paste items; paste text or images into the focused editor' },
        { keys: ['mod', 'alt', 'shift', 'V'], label: 'Paste item text only' },
        { keys: ['del'], label: 'Delete selected items' },
      ],
    },
    {
      title: 'Celebration review',
      shortcuts: [
        { keys: ['left'], label: 'Previous / next celebration', alt: ['right'] },
        { keys: ['Y'], label: 'Keep and continue' },
        { keys: ['N'], label: 'Mark for removal and continue' },
        { keys: ['C'], label: 'Copy removal list' },
        { keys: ['esc'], label: 'Close review' },
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
