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
        { keys: ['mod', 'F'], label: 'Find in current view / search goals' },
        { keys: ['enter'], label: 'Next match (in Find)' },
        { keys: ['shift', 'enter'], label: 'Previous match (in Find)' },
        { keys: ['mod', 'G'], label: 'Next find match', alt: ['F3'] },
        { keys: ['mod', 'shift', 'G'], label: 'Previous find match (while Find is open)', alt: ['shift', 'F3'] },
        { keys: ['mod', 'S'], label: 'Open Goal Stats (while in Goals)' },
        { keys: ['mod', 'Z'], label: 'Undo and reveal change (undoes typing while in the Add-a-goal form)' },
        { keys: ['mod', 'shift', 'Z'], label: 'Redo and reveal change (redoes typing while in the Add-a-goal form)', alt: ['mod', 'shift', 'C'] },
        { keys: ['mod', 'shift', 'P'], label: 'Open recovery panel' },
        { keys: ['esc'], label: 'Close backup browser (workspace shortcuts pause while browsing)' },
        { keys: ['mod', 'shift', 'G'], label: 'Generate selected day' },
        { keys: ['mod', 'N'], label: 'Create note (while in Notes)' },
        { keys: ['alt', 'A'], label: 'Toggle goal rhythm' },
        { keys: ['alt', 'K'], label: 'Add an idea to Proposition Party' },
        { keys: ['alt', 'I'], label: 'Toggle IMAX mode' },
        { keys: ['?'], label: 'Show this shortcuts reference' },
        { keys: ['esc'], label: 'Close overlay / clear selection' },
      ],
    },
    {
      title: 'Navigate',
      shortcuts: [
        { keys: ['alt', 'C'], label: 'Search' },
        { keys: ['W / S'], label: 'Hold to scroll Today up / down (no selection or editor focus)' },
        { keys: ['alt', 'X'], label: 'Open Next' },
        { keys: ['mod', 'D'], label: 'Complete the task shown on Next' },
        { keys: ['mod', 'D'], label: 'Delete the selected priority (while in Prioritize)' },
        { keys: ['mod', 'E'], label: 'Edit the selected priority (while in Prioritize)' },
        { keys: ['mod', 'S'], label: 'Spread out crowded priority numbers (while in Prioritize)' },
        { keys: ['alt', 'T'], label: 'Open Today; press again to jump to today' },
        { keys: ['alt', 'H'], label: 'Open List History' },
        { keys: ['alt', 'N'], label: 'Open Notes' },
        { keys: ['alt', 'P'], label: 'Open Projects' },
        { keys: ['alt', 'R'], label: 'Open Prioritize' },
        { keys: ['alt', 'B'], label: 'Open Buckets' },
        { keys: ['alt', 'D'], label: 'Open Days' },
        { keys: ['alt', 'E'], label: 'Open Lists' },
        { keys: ['alt', 'V'], label: 'Open Quizzes' },
        { keys: ['alt', 'G'], label: 'Open Goals' },
        { keys: ['alt', 'S'], label: 'Open Settings' },
        { keys: ['alt', 'Q'], label: 'Previous day, template, or quiz' },
        { keys: ['alt', 'W'], label: 'Next day, template, or quiz' },
      ],
    },
    {
      title: 'Selecting items',
      shortcuts: [
        { keys: ['mod', 'A'], label: 'Select all items' },
        { keys: ['mod', 'shift', 'A'], label: 'Select focused item, then all items' },
        { keys: ['enter'], label: 'Add a task after the selection on Today' },
        { keys: ['up'], label: 'Edit selection from start', alt: ['left'] },
        { keys: ['down'], label: 'Edit selection from end', alt: ['right'] },
        { keys: ['shift', 'up'], label: 'Extend selection', alt: ['shift', 'down'] },
        { keys: ['mod', 'shift', 'up'], label: 'Directly select / extend items', alt: ['mod', 'shift', 'down'] },
        { keys: ['esc'], label: 'Clear selection / leave task editor on Today' },
      ],
    },
    {
      title: 'Editing items',
      shortcuts: [
        { keys: ['mod', 'D'], label: 'Toggle done (keeps selected items selected)' },
        { keys: ['mod', 'R'], label: 'Hide / show subtasks of the active task (or its parent)' },
        { keys: ['alt', 'F'], label: 'Open a link from the active task (web or any Balance destination; first web URL takes priority)' },
        { keys: ['W / O'], label: 'Select previous list item (overlay)' },
        { keys: ['S / L'], label: 'Select next list item (overlay)' },
        { keys: ['E'], label: 'Edit selected list item (overlay)' },
        { keys: ['[ / ]'], label: 'Selected list / day-template probability −/+5% (first day-template option)' },
        { keys: ['altOrMod', '[ / ]'], label: 'List / day-template probability −/+5% at caret (Shift also works)' },
        { keys: ['T'], label: 'Add fresh time / clear time from selected items' },
        { keys: ['['], label: 'Move selected start earlier / later', alt: [']'] },
        { keys: ['shift', '['], label: 'Move selected end earlier / later', alt: ['shift', ']'] },
        { keys: ['alt', 'shift', 'T'], label: 'Add fresh task time / clear time' },
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
      title: 'Buckets',
      shortcuts: [
        { keys: ['G / P / A / T / U'], label: 'Move the selected idea to Genuinely / Possibly / Afterlife / Trash / Proposition Party' },
        { keys: ['up'], label: 'Select the previous / next idea', alt: ['down'] },
        { keys: ['Y / N'], label: 'Sorting: answer the key question' },
        { keys: ['B'], label: 'Sorting: back one idea', alt: ['left'] },
        { keys: ['M'], label: 'Sorting: append this idea to the previous one' },
        { keys: ['E'], label: 'Sorting: edit the idea' },
      ],
    },
    {
      title: 'Template review (from a review link)',
      shortcuts: [
        { keys: ['left'], label: 'Discard item (instant)', alt: ['del'] },
        { keys: ['right'], label: 'Keep item (after the 2-second read bar fills)', alt: ['enter'] },
        { keys: ['esc'], label: 'Cancel review without changing the template' },
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
