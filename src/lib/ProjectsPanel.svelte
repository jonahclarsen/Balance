<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core'
  import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
  import { onDestroy, tick } from 'svelte'
  import type { Project } from './types'
  import { plannerStore } from './store'
  import ProjectCard from './ProjectCard.svelte'
  import OverlayModal from './OverlayModal.svelte'
  import { projectReordering } from './projectReordering'
  import { mountInContentShell } from './contentShellOverlay'
  import RichTextEditor from './RichTextEditor.svelte'
  import { escapeHTML, sanitizeInlineHTML } from './planner'
  import { isProjectActive, isProjectOpen, PROJECT_ACTIVE_DAY_COUNTS } from './projects'
  export let projects: Project[] = []
  export let linkedProjectId = ''
  // Refreshed by the app each minute so active projects lapse on time.
  export let now = Date.now()
  let name = ''
  let nameHtml = ''
  // Bumped after adding so the still-focused name editor clears its DOM.
  let formResets = 0
  let detailsId = ''
  let pickingDays = false
  let highlightedId = ''
  let highlightTimer: ReturnType<typeof setTimeout> | undefined
  $: open = projects.filter(isProjectOpen)
  $: active = open.filter((project) => isProjectActive(project, now))
  $: inactive = open.filter((project) => !active.includes(project))
  $: completed = projects.filter((project) => !project.archived && project.completedAt).sort((a, b) => b.completedAt!.localeCompare(a.completedAt!))
  $: archived = projects.filter((project) => project.archived).sort((a, b) => (b.archivedAt ?? '').localeCompare(a.archivedAt ?? ''))
  $: details = projects.find((project) => project.id === detailsId)
  $: detailsActive = details ? active.includes(details) : false
  $: if (detailsId && !details) closeDetails()

  function shortDate(iso: string) {
    const date = new Date(iso)
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', ...(date.getFullYear() === new Date().getFullYear() ? {} : { year: 'numeric' }) })
  }
  function weekday(iso: string) {
    return new Date(iso).toLocaleDateString(undefined, { weekday: 'short' })
  }
  function activeEnd(iso: string) {
    return new Date(iso).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  }

  $: if (linkedProjectId) void reveal(linkedProjectId, true)
  async function reveal(id: string, openDetails: boolean) {
    await tick()
    document.getElementById(`project-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
    highlightedId = ''
    await tick()
    highlightedId = id
    clearTimeout(highlightTimer)
    highlightTimer = setTimeout(() => highlightedId = '', 1700)
    if (openDetails && projects.some((project) => project.id === id)) openProject(id)
  }
  onDestroy(() => clearTimeout(highlightTimer))

  function openProject(id: string) {
    detailsId = id
    pickingDays = false
  }
  function closeDetails() {
    detailsId = ''
    pickingDays = false
  }
  async function add() {
    const id = plannerStore.addProject(name, nameHtml)
    if (id) {
      name = ''
      nameHtml = ''
      formResets += 1
      void reveal(id, false)
    }
  }
  function activate(project: Project, days: number) {
    plannerStore.setProjectActiveDays(project.id, days)
    pickingDays = false
  }
  async function deleteForever(project: Project) {
    const prompt = `Delete “${project.name}” forever? You can still undo this action.`
    const confirmed = isTauri()
      ? await confirmDialog(prompt, { title: 'Delete project?', kind: 'warning' })
      : window.confirm(prompt)
    if (confirmed) plannerStore.permanentlyDeleteArchivedProject(project.id)
  }
</script>

<section class="projects-panel" aria-label="Projects">
  <header class="page-header">
    <h2>Projects</h2>
  </header>
  {#if linkedProjectId && !projects.some((project) => project.id === linkedProjectId)}<p class="muted">Project unavailable.</p>{/if}
  <form class="project-add" aria-label="Add a new project" on:submit|preventDefault={add}>
    <RichTextEditor
      className="rich-text-field"
      kind="project-name"
      inputId="new-project-name"
      placeholder="New project"
      html={nameHtml}
      text={name}
      ariaLabel="New project name"
      revision={$plannerStore.historyRevision + formResets}
      singleLine
      onKeyDown={(_editor, event) => {
        if (event.key !== 'Enter' || event.isComposing) return
        event.preventDefault()
        void add()
      }}
      onChange={(html, text) => {
        nameHtml = html
        name = text
      }}
    />
    <button class="primary" type="submit" disabled={!name.trim()}>Add</button>
  </form>
  <section class="project-section" aria-labelledby="open-projects-title">
    <h3 id="open-projects-title">Open</h3>
    {#if active.length}
      <div class="project-list" aria-label="Active projects" use:projectReordering={openProject}>{#each active as project (project.id)}<ProjectCard {project} active note={`until ${weekday(project.activeUntil!)}`} highlighted={highlightedId === project.id} onOpen={openProject} />{/each}</div>
    {/if}
    <div class="project-list" use:projectReordering={openProject}>{#each inactive as project (project.id)}<ProjectCard {project} highlighted={highlightedId === project.id} onOpen={openProject} />{/each}</div>
    {#if !open.length}<p class="muted">None.</p>{/if}
  </section>
  {#if completed.length}
    <section class="project-section" aria-labelledby="completed-projects-title">
      <h3 id="completed-projects-title">Completed</h3>
      <div class="project-list">{#each completed as project (project.id)}<ProjectCard {project} note={shortDate(project.completedAt!)} highlighted={highlightedId === project.id} onOpen={openProject} />{/each}</div>
    </section>
  {/if}
  {#if archived.length}
    <section class="project-section" aria-labelledby="archived-projects-title">
      <h3 id="archived-projects-title">Archived</h3>
      <div class="project-list">{#each archived as project (project.id)}<ProjectCard {project} note={project.archivedAt ? shortDate(project.archivedAt) : ''} highlighted={highlightedId === project.id} onOpen={openProject} />{/each}</div>
    </section>
  {/if}
  {#if details}
    {@const project = details}
    <div class="details-overlay" use:mountInContentShell>
    <OverlayModal linkURL={`balance://projects/${project.id}`} title={project.name} ariaLabel={`${project.name} details`} z={65} onClose={closeDetails}>
    <div class="project-details" id={'project-details-' + project.id} style:--project-color={project.color}>
      <div class="name-field"><span>Name</span><RichTextEditor
        className="rich-text-field"
        kind="project-name"
        inputId={`project-name:${project.id}`}
        html={sanitizeInlineHTML(project.nameHtml ?? escapeHTML(project.name))}
        text={project.name}
        ariaLabel="Project name"
        revision={$plannerStore.historyRevision}
        singleLine
        onChange={(html, text) => { if (text.trim()) plannerStore.updateProject(project.id, { name: text.trim(), nameHtml: html }) }}
      /></div>
      <label>Description<textarea value={project.description} on:change={(event) => plannerStore.updateProject(project.id, { description: event.currentTarget.value })}></textarea></label>
      {#if project.archived}
        <p class="project-status">Archived{project.archivedAt ? ` ${shortDate(project.archivedAt)}` : ''}</p>
        <div class="project-actions">
          <button type="button" on:click={() => plannerStore.setProjectStatus(project.id, 'open')}>Restore</button>
          <button class="ghost danger" type="button" on:click={() => deleteForever(project)}>Delete forever</button>
        </div>
      {:else if project.completedAt}
        <p class="project-status">Completed {shortDate(project.completedAt)}</p>
        <div class="project-actions">
          <button type="button" on:click={() => plannerStore.setProjectStatus(project.id, 'open')}>Reopen</button>
          <button type="button" on:click={() => plannerStore.setProjectStatus(project.id, 'archived')}>Archive</button>
        </div>
      {:else}
        {#if detailsActive}<p class="project-status">Active until {activeEnd(project.activeUntil!)}</p>{/if}
        {#if pickingDays}
          <p class="project-status">For how many days?</p>
          <div class="project-days" role="group" aria-label="Days active">
            {#each PROJECT_ACTIVE_DAY_COUNTS as days}
              <button type="button" aria-label={`${days} ${days === 1 ? 'day' : 'days'}`} on:click={() => activate(project, days)}>{days}</button>
            {/each}
          </div>
        {/if}
        <div class="project-actions">
          {#if !pickingDays}<button class="primary" type="button" on:click={() => pickingDays = true}>{detailsActive ? 'Change' : 'Mark active'}</button>{/if}
          {#if detailsActive}<button type="button" on:click={() => plannerStore.setProjectActiveDays(project.id, 0)}>Stop</button>{/if}
          <button type="button" on:click={() => plannerStore.setProjectStatus(project.id, 'completed')}>Complete</button>
          <button type="button" on:click={() => plannerStore.setProjectStatus(project.id, 'archived')}>Archive</button>
        </div>
      {/if}
    </div>
    </OverlayModal>
    </div>
  {/if}
</section>

<style>
  .projects-panel { min-width: 0; max-width: 640px; }
  .details-overlay { display: contents; }
  .page-header h2 { margin: 0; }
  .project-add { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px; margin-bottom: 20px; }
  .project-add button { font-size: 14px; padding: 8px 12px; }
  .project-section + .project-section { margin-top: 24px; }
  .project-section h3 { margin: 0 0 8px; font-size: 13px; font-weight: 600; color: var(--muted); }
  .project-list { position: relative; display: grid; gap: 6px; }
  .project-list + .project-list:not(:empty) { margin-top: 6px; }
  .project-list :global(.project-card) { cursor: pointer; touch-action: pan-y; }
  .project-list :global(.project-card.project-dragging) { position: relative; z-index: 2; cursor: grabbing; box-shadow: 0 12px 32px rgba(0, 0, 0, .22); pointer-events: none; }
  .project-list :global(.project-card.project-settling) { position: relative; z-index: 2; }
  .project-list :global(.project-drop-indicator) { position: absolute; background: var(--accent); border-radius: 2px; pointer-events: none; z-index: 1; }
  .project-details { display: grid; gap: 12px; }
  .project-details label, .name-field { display: grid; gap: 6px; font-size: 13px; }
  .project-status { margin: 0; color: var(--muted); font-size: 13px; }
  .project-actions, .project-days { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  .project-actions button { font-size: 14px; padding: 8px 10px; }
  .project-days button { min-width: 40px; font-size: 15px; padding: 8px 0; font-variant-numeric: tabular-nums; }
  textarea { width: 100%; box-sizing: border-box; min-height: 96px; resize: vertical; background: var(--paper-strong); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
</style>
