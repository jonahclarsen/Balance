<script lang="ts">
  import { sanitizeInlineHTML } from './planner'
  import type { NoteItem } from './types'

  export let item: NoteItem
  export let siblings: NoteItem[]
  export let depth = 0

  $: itemNumber = numberedPosition(siblings, item.id)
  $: safeHTML = sanitizeInlineHTML(item.html)

  function numberedPosition(items: NoteItem[], itemId: string) {
    const index = items.findIndex((candidate) => candidate.id === itemId)
    if (index < 0) return 1
    let start = index
    while (start > 0 && items[start - 1].kind === 'numbered') start -= 1
    return index - start + 1
  }
</script>

<div
  class="note-item note-readonly-item"
  class:note-heading={item.kind === 'heading'}
  class:note-done={item.kind === 'checklist' && item.done}
  class:note-list-item={item.kind === 'bullet' || item.kind === 'numbered' || item.kind === 'checklist'}
  class:note-bullet={item.kind === 'bullet'}
  class:note-numbered={item.kind === 'numbered'}
  data-note-item-number={item.kind === 'numbered' ? itemNumber : undefined}
>
  <div class="note-block" data-note-item-number={item.kind === 'numbered' ? itemNumber : undefined}>
    {#if item.kind === 'checklist'}
      <input class="check note-check" type="checkbox" checked={item.done} disabled aria-label={item.done ? 'Completed' : 'Not completed'} />
    {/if}
    <div class="note-text">{@html safeHTML}</div>
  </div>

  {#if item.children.length > 0}
    <div class="note-children">
      {#each item.children as child (child.id)}
        <svelte:self item={child} siblings={item.children} depth={depth + 1} />
      {/each}
    </div>
  {/if}
</div>
