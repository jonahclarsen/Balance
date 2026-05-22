<script lang="ts">
  import RichTextEditor from './RichTextEditor.svelte'
  import type { Id, TemplateItem, TemplateOption } from './types'

  export let item: TemplateItem
  export let depth = 0
  export let templateId: Id
  export let patchItem: (templateId: Id, itemId: Id, patch: Partial<TemplateItem>) => void
  export let deleteItem: (templateId: Id, itemId: Id) => void
  export let addChild: (templateId: Id, parentId: Id) => void
  export let addOption: (templateId: Id, itemId: Id) => void
  export let patchOption: (templateId: Id, itemId: Id, optionId: Id, patch: Partial<TemplateOption>) => void
  export let deleteOption: (templateId: Id, itemId: Id, optionId: Id) => void
  export let historyRevision: number

  $: probabilityTotal = item.options.reduce((sum, option) => sum + (Number(option.probability) || 0), 0)
</script>

<div class="template-item" style={`--depth: ${depth}`}>
  <div class="template-main">
    <div class="option-stack">
      {#each item.options as option, index (option.id)}
        <div class="option-row">
          <RichTextEditor
            className="template-text"
            kind="template-option"
            inputId={option.id}
            html={option.html}
            text={option.text}
            placeholder={index === 0 ? 'Template item' : 'Alternative'}
            ariaLabel={index === 0 ? 'Template item' : 'Template alternative'}
            revision={historyRevision}
            onChange={(html, text) => patchOption(templateId, item.id, option.id, { html, text })}
          />
          <input
            class="probability"
            type="number"
            min="0"
            max="100"
            value={option.probability}
            aria-label="Probability"
            on:input={(event) =>
              patchOption(templateId, item.id, option.id, {
                probability: Number(event.currentTarget.value) || 0,
              })}
          />
          <span class="percent">%</span>
          <button
            class="icon-button danger"
            type="button"
            title="Delete option"
            disabled={item.options.length === 1}
            on:click={() => deleteOption(templateId, item.id, option.id)}
          >
            ×
          </button>
        </div>
      {/each}
    </div>

    <div class="template-actions">
      <span class:bad-total={probabilityTotal !== 100} class="total">{probabilityTotal}%</span>
      <button class="icon-button" type="button" title="Add option" on:click={() => addOption(templateId, item.id)}>±</button>
      <button class="icon-button" type="button" title="Add child item" on:click={() => addChild(templateId, item.id)}>↳</button>
      <button class="icon-button danger" type="button" title="Delete item" on:click={() => deleteItem(templateId, item.id)}>×</button>
    </div>
  </div>

  {#if item.children.length > 0}
    <div class="children">
      {#each item.children as child (child.id)}
        <svelte:self
          item={child}
          depth={depth + 1}
          {templateId}
          {patchItem}
          {deleteItem}
          {addChild}
          {addOption}
          {patchOption}
          {deleteOption}
          {historyRevision}
        />
      {/each}
    </div>
  {/if}
</div>
