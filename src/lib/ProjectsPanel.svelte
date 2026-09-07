<script lang="ts">
  import { tick } from 'svelte'
  import type { Project, ProjectCheckIn } from './types'
  import { plannerStore } from './store'
  import ProjectCard from './ProjectCard.svelte'
  export let projects: Project[] = []
  export let checkIns: ProjectCheckIn[] = []
  export let linkedProjectId = ''
  let name = ''
  let showArchived = false
  let message = ''
  $: active = projects.filter((project) => !project.archived)
  $: visible = projects.filter((project) => showArchived || !project.archived || project.id === linkedProjectId)
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
    await tick()
    document.getElementById(`project-${id}`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }
  function add() {
    const id = plannerStore.addProject(name)
    if (id) { name = ''; linkedProjectId = id }
  }
  async function copyLink(id = '') {
    const link = `balance://projects${id ? '/' + id : ''}`
    try { await navigator.clipboard.writeText(link); message = 'Link copied' }
    catch { message = `Copy this link: ${link}` }
  }
</script>

<section class="projects-panel" aria-label="Project vibes">
  <header><div><p class="eyebrow">THE BIG PICTURE</p><h1>Project vibes</h1><p>How far along. How much you care. How it changes.</p></div><button type="button" on:click={() => copyLink()}>Copy page link</button></header>
  <div class="overview"><strong>{active.length}</strong><span>{active.length === 1 ? 'project' : 'projects'} on the go</span><label><input type="checkbox" bind:checked={showArchived} /> Show archived</label></div>
  <form on:submit|preventDefault={add}><input aria-label="New project name" placeholder="What are you working on?" bind:value={name} maxlength="160" /><button type="submit" disabled={!name.trim()}>Add project</button></form>
  <p class="template-tip">For an occasional check-in, paste the page or project link into a day or list template item, then lower that item’s probability.</p>
  <p class="status" role="status">{message}</p>
  {#if linkedProjectId && !projects.some((project) => project.id === linkedProjectId)}<p>This project is no longer available. Your other projects are below.</p>{/if}
  {#if visible.length === 0}<div class="empty"><h2>A little perspective on everything you’re making.</h2><p>Add your first project, set the sliders, and save a check-in. The ring shows work complete; the heart shows how much you’re feeling it.</p></div>{/if}
  <div class="project-grid">{#each visible as project (project.id)}<ProjectCard {project} entries={histories.get(project.id) ?? []} highlighted={linkedProjectId === project.id} {copyLink} />{/each}</div>
</section>

<style>
  .projects-panel { max-width: 1200px; width: 100%; box-sizing: border-box; padding: 32px; margin: 0 auto; }
  header { display: flex; align-items: center; justify-content: space-between; gap: 20px; } h1 { margin: 5px 0; font-size: 2rem; letter-spacing: -.04em; } header p { opacity: .65; } .eyebrow { font-size: .7rem; letter-spacing: .15em; }
  button { font: inherit; font-size: .85rem; padding: 10px 14px; border: 1px solid var(--line); border-radius: 8px; background: transparent; color: inherit; cursor: pointer; } button:disabled { opacity: .4; cursor: default; }
  .overview { display: flex; align-items: baseline; flex-wrap: wrap; gap: 10px; margin: 24px 0; }.overview strong { font-size: 2rem; }.overview span { opacity: .65; }.overview label { margin-left: auto; font-size: .85rem; }
  form { display: flex; gap: 10px; } form input { flex: 1; min-width: 0; padding: 12px; font: inherit; border: 1px solid var(--line); border-radius: 8px; color: inherit; background: transparent; }
  .template-tip, .status { font-size: .8rem; opacity: .7; line-height: 1.5; overflow-wrap: anywhere; }.status:empty { display: none; }
  .project-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 310px), 1fr)); gap: 20px; margin-top: 28px; align-items: start; }
  .empty { padding: 48px 16px; max-width: 500px; margin: auto; text-align: center; }.empty h2 { font-size: 1.2rem; }.empty p { opacity: .65; line-height: 1.6; }
  @media (max-width: 600px) { .projects-panel { padding: 20px 14px; } header { align-items: start; flex-direction: column; gap: 6px; } h1 { font-size: 1.75rem; } }
</style>
