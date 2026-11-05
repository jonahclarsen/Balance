<script lang="ts">
  import { onMount } from 'svelte'

  // The XP and Vista themes draw Settings as Control Panel. Its task pane lists
  // every section that is actually rendered, so platform-only sections stay in
  // sync without a second hand-maintained list. Other themes hide the pane.
  type Section = { key: string; label: string; element: HTMLElement }

  let pane: HTMLElement
  let sections: Section[] = []

  function collect() {
    const panel = pane?.parentElement
    if (!panel) return
    const next = [...panel.querySelectorAll<HTMLElement>(':scope > [data-cp]')].map(element => ({
      key: element.dataset.cp ?? '',
      label: element.querySelector('h3')?.textContent?.trim() ?? '',
      element,
    })).filter(section => section.label)
    const changed = next.length !== sections.length
      || next.some((section, index) => section.element !== sections[index].element || section.label !== sections[index].label)
    if (changed) sections = next
  }

  function open(section: Section) {
    const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches
    section.element.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' })
  }

  onMount(() => {
    collect()
    const observer = new MutationObserver(collect)
    if (pane.parentElement) observer.observe(pane.parentElement, { childList: true })
    return () => observer.disconnect()
  })
</script>

<aside class="control-panel-tasks" aria-label="Settings sections" bind:this={pane}>
  <div class="control-panel-group">
    <h3 class="control-panel-group-title"><span class="control-panel-group-icon" aria-hidden="true"></span>Control Panel</h3>
    <ul>
      {#each sections as section (section.element)}
        <li>
          <button type="button" class="control-panel-task" data-cp-task={section.key} on:click={() => open(section)}>
            <span class="control-panel-task-icon" aria-hidden="true"></span>{section.label}
          </button>
        </li>
      {/each}
    </ul>
  </div>
</aside>
