<script lang="ts">
  import { isTauri } from '@tauri-apps/api/core'
  import { confirm as confirmDialog } from '@tauri-apps/plugin-dialog'
  import { tick } from 'svelte'
  import type { Project, ProjectCheckIn } from './types'
  import ProbabilitySlider from './ProbabilitySlider.svelte'
  import { plannerStore } from './store'
  import { todayISO } from './planner'
  import { projectCheckInForDay } from './projects'
  export let project: Project
  export let entries: ProjectCheckIn[] = []
  export let highlighted = false
  export let currentDay: string
  let progress: number | null = null
  let heart: number | null = null
  let checkingIn = false
  let detailsOpen = false
  let editingCheckInId: string | null = null
  let checkInForm: HTMLFormElement | undefined
  $: history = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  $: latest = history.at(-1)
  $: todaysCheckIn = projectCheckInForDay(history, project.id, currentDay)
  $: editingCheckIn = history.find((entry) => entry.id === editingCheckInId)
  $: if (checkingIn && editingCheckInId && !editingCheckIn) checkingIn = false
  async function openCheckIn(entry?: ProjectCheckIn) {
    editingCheckInId = entry?.id ?? null
    progress = (entry ?? latest)?.progress ?? null
    heart = (entry ?? latest)?.heart ?? null
    checkingIn = true
    await tick()
    checkInForm?.scrollIntoView({ block: 'nearest' })
    checkInForm?.querySelector<HTMLInputElement>('input[type="range"]')?.focus({ preventScroll: true })
  }
  $: start = Date.parse(history[0]?.createdAt ?? '')
  $: end = Date.parse(latest?.createdAt ?? '')
  $: points = history.map((entry) => ({ ...entry, x: end > start ? 10 + (Date.parse(entry.createdAt) - start) / (end - start) * 280 : 150 }))
  $: progressLine = points.map((point) => `${point.x},${110 - point.progress}`).join(' ')
  $: heartLine = points.map((point) => `${point.x},${110 - point.heart}`).join(' ')
  function save() {
    if (progress === null || heart === null) return
    if (editingCheckInId) plannerStore.updateProjectCheckIn(editingCheckInId, progress, heart)
    else plannerStore.checkInProject(project.id, progress, heart)
    checkingIn = false
  }
  async function deleteCheckIn(entry: ProjectCheckIn) {
    const prompt = `Delete the check-in from ${new Date(entry.createdAt).toLocaleString()}? You can still undo this action.`
    const confirmed = isTauri()
      ? await confirmDialog(prompt, { title: 'Delete check-in?', kind: 'warning' })
      : window.confirm(prompt)
    if (confirmed) plannerStore.deleteProjectCheckIn(entry.id)
  }
</script>

<article class:highlighted class="project-card metric-card" id={'project-' + project.id} style:--project-color={project.color}>
  <header>
    <svg class="project-visual" viewBox="0 0 100 100" role="img" aria-label={latest ? `${latest.progress}% work complete; ${latest.heart}% heart in it` : 'No check-in yet'}>
      <circle class="ring-track" cx="50" cy="50" r="41" />
      <circle class="ring-progress" cx="50" cy="50" r="41" stroke-dasharray={`${(latest?.progress ?? 0) * 2.576} 257.6`} transform="rotate(-90 50 50)" />
      <!-- Cactus's drawHeartPath contour, centered inside the progress ring. -->
      <path d="M45 84.334 6.802 46.136C2.416 41.75 0 35.918 0 29.716S2.416 17.682 6.802 13.296 17.019 6.494 23.222 6.494 35.256 8.91 39.642 13.296L45 18.654 50.358 13.296C54.744 8.91 60.576 6.494 66.778 6.494S78.812 8.91 83.198 13.296C87.585 17.682 90 23.513 90 29.716S87.585 41.75 83.198 46.136L45 84.334Z" transform="translate(25.25 25.0223) scale(.55)" fill="currentColor" fill-opacity={latest ? 1 : 0} stroke="currentColor" stroke-width="3" stroke-linejoin="round" stroke-opacity={latest ? 0 : 1} />
    </svg>
    <div class="project-heading"><h2>{project.name}</h2><p>{project.archived ? 'Archived' : latest ? `Last check-in ${new Date(latest.createdAt).toLocaleDateString()}` : 'No check-in yet'}</p></div>
  </header>
  {#if project.description}<p class="description">{project.description}</p>{/if}
  {#if !checkingIn}<dl class="ratings"><div><dt>Work complete</dt><dd>{latest ? `${latest.progress}%` : 'Not set'}</dd></div><div><dt>Heart in it</dt><dd>{latest ? `${latest.heart}%` : 'Not set'}</dd></div></dl>{/if}
  {#if checkingIn}
      <form class="check-in" id={'project-check-in-' + project.id} bind:this={checkInForm} on:submit|preventDefault={save}>
        {#if editingCheckIn}<p class="check-in-date">Editing check-in from {new Date(editingCheckIn.createdAt).toLocaleString()}</p>{/if}
        <div class="rating-control"><span>Work complete</span><ProbabilitySlider step={5} value={progress ?? 0} unset={progress === null} ariaLabel={`Work complete for ${project.name}`} onChange={(value) => progress = value} generousHitbox /></div>
        <div class="rating-control"><span>Heart in it</span><ProbabilitySlider step={5} value={heart ?? 0} unset={heart === null} ariaLabel={`Heart in it for ${project.name}`} onChange={(value) => heart = value} generousHitbox /></div>
      </form>
  {/if}
  <footer>
    {#if checkingIn}
      <button class="primary" type="submit" form={'project-check-in-' + project.id} disabled={progress === null || heart === null}>Save check-in</button>
      <button type="button" on:click={() => checkingIn = false}>Cancel</button>
    {:else if !project.archived}
      <button type="button" on:click={() => openCheckIn(projectCheckInForDay(history, project.id, todayISO()))}>{todaysCheckIn ? 'Edit check-in' : 'Check in'}</button>
    {/if}
    <button class="details-toggle" type="button" aria-expanded={detailsOpen} aria-controls={'project-details-' + project.id} on:click={() => detailsOpen = !detailsOpen}>
      {detailsOpen ? 'Close details' : 'View details'}
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={detailsOpen ? 'm6 15 6-6 6 6' : 'm6 9 6 6 6-6'} /></svg>
    </button>
  </footer>
  {#if detailsOpen}
    <div class="edit-details" id={'project-details-' + project.id}>
      <label>Name<input aria-label="Project name" value={project.name} on:change={(event) => plannerStore.updateProject(project.id, { name: event.currentTarget.value.trim() || project.name })} /></label>
      <label>Description<textarea value={project.description} on:change={(event) => plannerStore.updateProject(project.id, { description: event.currentTarget.value })}></textarea></label>
      <section class="project-history" aria-label="Check-in history">
      <h3>History · {history.length} {history.length === 1 ? 'check-in' : 'check-ins'}</h3>
      {#if history.length}
      <div class="legend"><span>Solid: work complete</span><span>Dashed: heart in it</span></div>
      <svg class="history-chart" viewBox="0 0 300 120" role="img" aria-label="Project ratings over time, from 0 to 100 percent">
        <path d="M10 10H290 M10 60H290 M10 110H290" class="grid" />
        <polyline points={progressLine} fill="none" stroke="currentColor" stroke-width="2" />
        <polyline points={heartLine} fill="none" stroke="currentColor" stroke-width="2" stroke-dasharray="5 4" />
        {#each points as point}
          <circle cx={point.x} cy={110 - point.progress} r="3" fill="currentColor"><title>{new Date(point.createdAt).toLocaleString()}: work {point.progress}%</title></circle>
          <circle cx={point.x} cy={110 - point.heart} r="3" fill="var(--paper)" stroke="currentColor"><title>{new Date(point.createdAt).toLocaleString()}: heart {point.heart}%</title></circle>
        {/each}
      </svg>
      <div class="endpoints"><span>{new Date(history[0].createdAt).toLocaleDateString()}</span><span>{new Date(latest!.createdAt).toLocaleDateString()}</span></div>
      <div class="history-table"><table>
        <thead><tr><th>Check-in</th><th>Work</th><th>Heart</th><th>Actions</th></tr></thead>
        <tbody>{#each [...history].reverse() as entry (entry.id)}
          <tr>
            <td>{new Date(entry.createdAt).toLocaleString()}</td><td>{entry.progress}%</td><td>{entry.heart}%</td>
            <td><div class="history-actions">
              <button class="ghost" type="button" aria-label={`Edit check-in from ${new Date(entry.createdAt).toLocaleString()}`} title="Edit check-in" on:click={() => openCheckIn(entry)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m16 3 5 5M4 20l4-1L21 6a2.12 2.12 0 0 0-3-3L5 16l-1 4Z" /></svg>
              </button>
              <button class="ghost danger" type="button" aria-label={`Delete check-in from ${new Date(entry.createdAt).toLocaleString()}`} title="Delete check-in" on:click={() => deleteCheckIn(entry)}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7M14 10v7" /></svg>
              </button>
            </div></td>
          </tr>
        {/each}</tbody>
      </table></div>
      {:else}<p>No check-ins yet.</p>{/if}
      </section>
      <button type="button" on:click={() => plannerStore.updateProject(project.id, { archived: !project.archived })}>{project.archived ? 'Restore project' : 'Archive project'}</button>
    </div>
  {/if}
</article>

<style>
  .highlighted { outline: 2px solid var(--accent); outline-offset: 2px; }
  header { display: flex; gap: 12px; align-items: center; }
  .project-visual { width: 48px; height: 48px; flex: 0 0 48px; color: var(--project-color); }
  .ring-track, .ring-progress { fill: none; stroke-width: 5; }
  .ring-track { stroke: currentColor; opacity: .18; }
  .ring-progress { stroke: currentColor; stroke-linecap: round; }
  .project-heading { min-width: 0; }
  h2 { margin: 0; font-size: 18px; overflow-wrap: anywhere; }
  p { margin: 4px 0 0; color: var(--muted); font-size: 13px; }
  .description { white-space: pre-wrap; overflow-wrap: anywhere; }
  .ratings { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; margin: 0; font-size: 13px; }
  .ratings div { display: grid; gap: 6px; } dt { color: var(--muted); } dd { margin: 0; font-variant-numeric: tabular-nums; }
  .check-in { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
  .rating-control { display: grid; gap: 8px; min-width: 0; font-size: 13px; --slider-readout-width: 44px; }
  .rating-control :global(.probability-slider) { min-width: 0; gap: 8px; }
  .rating-control :global(.track-wrap) { flex: 1; width: auto; min-width: 0; }
  .rating-control :global(.probability-readout) { flex: 0 0 44px; }
  .check-in-date { grid-column: 1 / -1; }
  footer { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; }
  footer button { font-size: 14px; padding: 8px 10px; }
  h3 { margin: 0; font-size: 13px; font-weight: 500; }
  .details-toggle { display: inline-flex; align-items: center; gap: 6px; }
  .details-toggle svg, .history-actions svg { flex: 0 0 auto; }
  .history-actions { display: flex; gap: 2px; }
  .history-actions button { display: grid; place-items: center; padding: 6px; min-width: 30px; min-height: 32px; }
  .endpoints, .legend { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); }
  .legend { margin-top: 12px; }
  .history-chart { width: 100%; max-height: 160px; color: var(--project-color); }
  /* Keep bright saved colors legible on paper without changing the project's hue. */
  :global(:root:not([data-color-scheme='dark'])) :is(.project-visual, .history-chart) {
    color: color-mix(in srgb, var(--project-color) 75%, black);
    color: oklch(from var(--project-color) min(l, 0.58) c h);
  }
  .grid { stroke: var(--line); fill: none; }
  .history-table { max-height: 180px; overflow: auto; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 3px; border-bottom: 1px solid var(--line); }
  .edit-details { display: grid; gap: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
  .edit-details label { display: grid; gap: 6px; font-size: 13px; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; background: var(--paper-strong); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
</style>
