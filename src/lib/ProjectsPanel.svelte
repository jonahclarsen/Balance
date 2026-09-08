<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core'
  import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
  import { tick } from 'svelte'
  import type { Project, ProjectCheckIn } from './types'
  import { plannerStore } from './store'
  import ProjectCard from './ProjectCard.svelte'
  export let projects: Project[] = []
  export let checkIns: ProjectCheckIn[] = []
  export let linkedProjectId = ''
  let name = ''
  let archiveOpen = false
  let archivedDetailId = ''
  let message = ''
  $: active = projects.filter((project) => !project.archived)
  $: archived = projects.filter((project) => project.archived)
  $: histories = groupHistory(checkIns)
  function groupHistory(entries: ProjectCheckIn[]) {
    const grouped = new Map<string, ProjectCheckIn[]>()
    for (const entry of entries) {
      const group = grouped.get(entry.projectId) ?? []
      group.push(entry)
      grouped.set(entry.projectId, group)
    }
    return grouped
  }
  $: if (linkedProjectId) reveal(linkedProjectId)
  async function reveal(id: string) {
    if (projects.some((project) => project.id === id && project.archived)) { archiveOpen = true; archivedDetailId = id }
    await tick()
    document.getElementById(`project-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  function add() {
    const id = plannerStore.addProject(name)
    if (id) { name = ''; linkedProjectId = id }
  }
  async function deleteForever(project: Project) {
    const prompt = `Delete “${project.name}” and its check-in history from the archive forever? You can still undo this action.`
    const confirmed = isTauri()
      ? await confirmDialog(prompt, { title: 'Delete archived project?', kind: 'warning' })
      : window.confirm(prompt)
    if (confirmed) plannerStore.permanentlyDeleteArchivedProject(project.id)
  }
  async function copyLink(id = '') {
    const link = `balance://projects${id ? '/' + id : ''}`
    try { await navigator.clipboard.writeText(link); message = 'Link copied' }
    catch { message = `Copy this link: ${link}` }
  }
</script>

<section class="projects-panel" aria-label="Project vibes">
  <header class="page-header"><h2>Projects</h2><button type="button" on:click={() => copyLink()}>Copy page link</button></header>
  <form class="project-add" on:submit|preventDefault={add}><input aria-label="New project name" placeholder="Project name" bind:value={name} maxlength="160" /><button class="primary" type="submit" disabled={!name.trim()}>Add project</button></form>
  {#if message}<p class="status muted" role="status">{message}</p>{/if}
  {#if linkedProjectId && !projects.some((project) => project.id === linkedProjectId)}<p class="muted">Project unavailable.</p>{/if}
  <div class="project-grid">{#each active as project (project.id)}<ProjectCard {project} entries={histories.get(project.id) ?? []} highlighted={linkedProjectId === project.id} {copyLink} />{/each}</div>
  <div class="template-panel-actions"><button class="ghost" class:active={archiveOpen} type="button" aria-expanded={archiveOpen} aria-controls="project-archive" on:click={() => archiveOpen = !archiveOpen}>View Archive</button></div>
  {#if archiveOpen}
    <section id="project-archive" class="list-item-archive" aria-labelledby="project-archive-title">
      <div class="list-item-archive-header"><h3 id="project-archive-title">Archive</h3><span>{archived.length} saved</span></div>
      {#if !archived.length}<p class="list-item-archive-empty">No archived projects.</p>{/if}
      <ul class="list-item-archive-list">
        {#each archived as project (project.id)}
          <li>
            <div class="list-item-archive-row">
              <div class="list-item-archive-copy"><strong>{project.name}</strong><span>{histories.get(project.id)?.length ?? 0} check-ins</span></div>
              <div class="list-item-archive-actions">
                <button class="ghost" type="button" aria-expanded={archivedDetailId === project.id} on:click={() => archivedDetailId = archivedDetailId === project.id ? '' : project.id}>View</button>
                <button type="button" on:click={() => plannerStore.updateProject(project.id, { archived: false })}>Restore</button>
                <button class="ghost danger" type="button" on:click={() => deleteForever(project)}>Delete forever</button>
              </div>
            </div>
            {#if archivedDetailId === project.id}<ProjectCard {project} entries={histories.get(project.id) ?? []} highlighted={linkedProjectId === project.id} {copyLink} />{/if}
          </li>
        {/each}
      </ul>
    </section>
  {/if}
</section>

<style>
  .projects-panel { min-width: 0; }
  .page-header h2 { margin: 0; }
  .project-add { display: flex; gap: 8px; margin-bottom: 16px; }
  .project-add input { flex: 1; min-width: 0; }
  .project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 300px), 1fr)); gap: 16px; align-items: start; }
  .status { overflow-wrap: anywhere; }
</style>
