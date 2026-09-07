<script lang="ts">
  import type { Project, ProjectCheckIn } from './types'
  import { plannerStore } from './store'
  export let project: Project
  export let entries: ProjectCheckIn[] = []
  export let highlighted = false
  export let copyLink: (id?: string) => void
  let progress = 0
  let heart = 50
  let editing = false
  let saved = ''
  $: history = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  $: latest = history.at(-1)
  $: { progress = latest?.progress ?? 0; heart = latest?.heart ?? 50 }
  $: start = Date.parse(history[0]?.createdAt ?? '')
  $: end = Date.parse(latest?.createdAt ?? '')
  $: points = history.map((entry) => ({ ...entry, x: end > start ? 10 + (Date.parse(entry.createdAt) - start) / (end - start) * 280 : 150 }))
  $: progressLine = points.map((point) => `${point.x},${110 - point.progress}`).join(' ')
  $: heartLine = points.map((point) => `${point.x},${110 - point.heart}`).join(' ')
  function save() {
    plannerStore.checkInProject(project.id, progress, heart)
    saved = 'Check-in saved'
  }
</script>

<article class:highlighted class="project-card" id={'project-' + project.id} style:--project-color={project.color}>
  <header>
    <svg class="project-visual" viewBox="0 0 100 100" role="img" aria-label={`${progress}% work complete; ${heart}% heart in it`}>
      <circle class="ring-track" cx="50" cy="50" r="41" />
      <circle class="ring-progress" cx="50" cy="50" r="41" stroke-dasharray={`${progress * 2.576} 257.6`} transform="rotate(-90 50 50)" />
      <path d="M50 69 30 49C17 35 36 23 50 38 64 23 83 35 70 49Z" fill="currentColor" fill-opacity={0.15 + heart / 118} />
    </svg>
    <div class="project-heading"><h2>{project.name}</h2><p>{project.archived ? 'Archived' : latest ? `Last check-in ${new Date(latest.createdAt).toLocaleDateString()}` : 'Ready for your first check-in'}</p></div>
  </header>
  {#if project.description}<p class="description">{project.description}</p>{/if}
  {#if !project.archived}
    <label>Work complete <output>{progress}%</output><input aria-label={`Work complete for ${project.name}`} type="range" min="0" max="100" step="1" bind:value={progress} on:input={() => saved = ''} /></label>
    <div class="endpoints"><span>Just starting</span><span>Finished</span></div>
    <label>Heart in it <output>{heart}%</output><input aria-label={`Heart in it for ${project.name}`} type="range" min="0" max="100" step="1" bind:value={heart} on:input={() => saved = ''} /></label>
    <div class="endpoints"><span>Not feeling it</span><span>All in</span></div>
    <div class="save-row"><button type="button" on:click={save}>Save check-in</button><span role="status">{saved}</span></div>
  {/if}
  {#if history.length}
    <details>
      <summary>History · {history.length} {history.length === 1 ? 'check-in' : 'check-ins'}</summary>
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
      <div class="history-table"><table><thead><tr><th>Check-in</th><th>Work</th><th>Heart</th></tr></thead><tbody>{#each [...history].reverse() as entry}<tr><td>{new Date(entry.createdAt).toLocaleString()}</td><td>{entry.progress}%</td><td>{entry.heart}%</td></tr>{/each}</tbody></table></div>
    </details>
  {:else}<p class="history-hint">Save a check-in to start your history. Ratings can go up or down.</p>{/if}
  <footer><button type="button" on:click={() => copyLink(project.id)}>Copy project link</button><button type="button" on:click={() => editing = !editing}>{editing ? 'Close details' : 'Edit details'}</button></footer>
  {#if editing}
    <div class="edit-details">
      <label>Name<input aria-label="Project name" value={project.name} on:change={(event) => plannerStore.updateProject(project.id, { name: event.currentTarget.value.trim() || project.name })} /></label>
      <label>Description<textarea value={project.description} on:change={(event) => plannerStore.updateProject(project.id, { description: event.currentTarget.value })}></textarea></label>
      <label>Project color<input type="color" value={project.color} on:change={(event) => plannerStore.updateProject(project.id, { color: event.currentTarget.value })} /></label>
      <button type="button" on:click={() => plannerStore.updateProject(project.id, { archived: !project.archived })}>{project.archived ? 'Restore project' : 'Archive project'}</button>
    </div>
  {/if}
</article>

<style>
  .project-card { border: 1px solid var(--line); border-radius: 18px; padding: 22px; min-width: 0; background: var(--paper); }
  .highlighted { outline: 2px solid var(--project-color); outline-offset: 3px; }
  header { display: flex; gap: 16px; align-items: center; margin-bottom: 18px; }
  .project-visual { width: 80px; height: 80px; flex: 0 0 80px; color: var(--project-color); }
  .ring-track, .ring-progress { fill: none; stroke-width: 5; }
  .ring-track { stroke: currentColor; opacity: .18; }.ring-progress { stroke: currentColor; stroke-linecap: round; }
  .project-heading { min-width: 0; } h2 { margin: 0; font-size: 1.25rem; overflow-wrap: anywhere; }
  p { margin: 6px 0; opacity: .7; font-size: .85rem; } .description { white-space: pre-wrap; overflow-wrap: anywhere; margin-bottom: 18px; }
  label { display: block; font-size: .9rem; margin-top: 18px; } output { float: right; font-variant-numeric: tabular-nums; }
  input[type=range] { display: block; width: 100%; margin: 12px 0 6px; accent-color: var(--project-color); cursor: pointer; }
  .endpoints, .legend { display: flex; justify-content: space-between; gap: 8px; font-size: .72rem; opacity: .65; }
  .save-row, footer { display: flex; align-items: center; flex-wrap: wrap; gap: 10px; margin-top: 20px; } .save-row span { font-size: .8rem; }
  button { font: inherit; font-size: .8rem; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; color: inherit; background: transparent; cursor: pointer; }
  button:hover { border-color: var(--project-color); } .save-row button { background: var(--project-color); color: #101820; border-color: transparent; }
  details { margin-top: 20px; } summary { cursor: pointer; font-size: .85rem; } .legend { margin-top: 16px; }
  .history-chart { width: 100%; color: var(--project-color); }.grid { stroke: var(--line); fill: none; }
  .history-table { max-height: 180px; overflow: auto; margin-top: 12px; } table { width: 100%; border-collapse: collapse; font-size: .72rem; } th, td { text-align: left; padding: 6px 3px; border-bottom: 1px solid var(--line); }
  .history-hint { margin-top: 18px; } .edit-details { border-top: 1px solid var(--line); margin-top: 16px; }
  input:not([type=range]):not([type=color]), textarea { display: block; box-sizing: border-box; width: 100%; margin: 6px 0 12px; padding: 8px; font: inherit; background: transparent; color: inherit; border: 1px solid var(--line); border-radius: 6px; } textarea { resize: vertical; } input[type=color] { display: block; margin: 8px 0 16px; }
</style>
