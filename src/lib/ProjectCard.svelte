<script lang="ts">
  import type { Project } from './types'
  import { escapeHTML, isURL, sanitizeInlineHTML } from './planner'
  import { openExternalURL } from './externalLinks'
  export let project: Project
  // Right-hand note: when it stops being active, or when it was completed or archived.
  export let note = ''
  export let active = false
  export let highlighted = false
  export let onOpen: (projectId: string) => void
  $: nameHtml = withDescriptionColon(sanitizeInlineHTML(project.nameHtml ?? escapeHTML(project.name)), Boolean(project.description.trim()))
  $: descriptionPreview = previewLine(project.description)
  // A trailing colon hints that the project has a description; only the card shows it.
  function withDescriptionColon(html: string, hasDescription: boolean) {
    if (!hasDescription) return html
    let rest = html
    let closingTags = ''
    for (;;) {
      rest = rest.replace(/(?:\s|&nbsp;|&#160;)+$/, '')
      const tag = rest.match(/<\/[a-z]+>$|<br\s*\/?>$/i)
      if (!tag) break
      rest = rest.slice(0, -tag[0].length)
      if (!tag[0].startsWith('<br')) closingTags = tag[0] + closingTags
    }
    return rest.endsWith(':') ? rest + closingTags : `${rest}${closingTags}:`
  }
  // The card shows the description's first line; an ellipsis marks that more follows.
  function previewLine(description: string) {
    const [first = '', ...rest] = description.trim().split(/\s*\n\s*/)
    return rest.length ? `${first}…` : first
  }
  function click(event: MouseEvent) {
    const anchor = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[href]') : null
    if (!anchor) return onOpen(project.id)
    event.preventDefault()
    const href = anchor.getAttribute('href') ?? ''
    if (isURL(href)) void openExternalURL(href)
  }
  // Holding a card on touch lifts it for reordering instead of opening the link menu.
  function contextMenu(event: MouseEvent) {
    const touch = (event as PointerEvent).pointerType === 'touch' || (event as MouseEvent & { sourceCapabilities?: { firesTouchEvents?: boolean } }).sourceCapabilities?.firesTouchEvents
    if (!touch) return
    event.preventDefault()
    event.stopPropagation()
  }
</script>

<!-- Reorderable lists capture the pointer, so they open taps through projectReordering instead of this click. -->
<div
  data-balance-link={`balance://projects/${project.id}`}
  class="project-card"
  class:active
  class:highlighted
  id={'project-' + project.id}
  style:--project-color={project.color}
  role="button"
  tabindex="0"
  aria-haspopup="dialog"
  on:click={click}
  on:contextmenu={contextMenu}
  on:keydown={(event) => {
    if (event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return
    event.preventDefault()
    onOpen(project.id)
  }}
>
  <span class="project-dot" aria-hidden="true"></span>
  <span class="project-text">
    <span class="project-name">{@html nameHtml}</span>
    {#if descriptionPreview}<span class="project-description">{descriptionPreview}</span>{/if}
  </span>
  {#if note}<span class="project-note">{note}</span>{/if}
</div>

<style>
  div.project-card { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 40px; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--paper); user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
  div.project-card:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  div.project-card.active { border-color: color-mix(in srgb, var(--project-color) 55%, var(--line)); background: color-mix(in srgb, var(--project-color) 12%, var(--paper)); }
  div.project-card.highlighted { animation: project-highlight 1.6s ease-out; }
  @keyframes project-highlight {
    0%, 40% { box-shadow: 0 0 0 3px color-mix(in srgb, var(--project-color) 65%, transparent); }
    100% { box-shadow: 0 0 0 3px transparent; }
  }
  .project-dot { flex: 0 0 10px; width: 10px; height: 10px; border-radius: 50%; background: var(--project-color); }
  .project-text { display: flex; flex: 1; flex-direction: column; min-width: 0; }
  .project-name, .project-description { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .project-name { font-size: 15px; }
  .project-description { color: var(--muted); font-size: 13px; }
  .project-name :global(a) { color: inherit; text-decoration: underline; text-decoration-color: var(--accent-strong); }
  .project-note { flex: 0 0 auto; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) {
    div.project-card.highlighted { animation: none; box-shadow: 0 0 0 3px color-mix(in srgb, var(--project-color) 65%, transparent); }
  }
</style>
