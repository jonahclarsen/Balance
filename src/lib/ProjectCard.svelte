<script lang="ts">
  import type { Project, ProjectCheckIn } from './types'
  import ProbabilitySlider from './ProbabilitySlider.svelte'
  import { plannerStore } from './store'
  export let project: Project
  export let entries: ProjectCheckIn[] = []
  export let highlighted = false
  export let copyLink: (id?: string) => void
  let progress: number | null = null
  let heart: number | null = null
  let checkingIn = false
  let editing = false
  let saved = ''
  $: history = [...entries].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  $: latest = history.at(-1)
  function openCheckIn() {
    progress = latest?.progress ?? null
    heart = latest?.heart ?? null
    saved = ''
    checkingIn = true
  }
  $: start = Date.parse(history[0]?.createdAt ?? '')
  $: end = Date.parse(latest?.createdAt ?? '')
  $: points = history.map((entry) => ({ ...entry, x: end > start ? 10 + (Date.parse(entry.createdAt) - start) / (end - start) * 280 : 150 }))
  $: progressLine = points.map((point) => `${point.x},${110 - point.progress}`).join(' ')
  $: heartLine = points.map((point) => `${point.x},${110 - point.heart}`).join(' ')
  function save() {
    if (progress === null || heart === null) return
    plannerStore.checkInProject(project.id, progress, heart)
    checkingIn = false
    saved = 'Check-in saved'
  }
</script>

<article class:highlighted class="project-card metric-card" id={'project-' + project.id} style:--project-color={project.color}>
  <header>
    <svg class="project-visual" viewBox="0 0 100 100" role="img" aria-label={latest ? `${latest.progress}% work complete; ${latest.heart}% heart in it` : 'No check-in yet'}>
      <circle class="ring-track" cx="50" cy="50" r="41" />
      <circle class="ring-progress" cx="50" cy="50" r="41" stroke-dasharray={`${(latest?.progress ?? 0) * 2.576} 257.6`} transform="rotate(-90 50 50)" />
      <path d="M50 69 30 49C17 35 36 23 50 38 64 23 83 35 70 49Z" fill="currentColor" fill-opacity={latest ? 0.15 + latest.heart / 118 : 0} stroke="currentColor" stroke-opacity={latest ? 0 : 0.3} />
    </svg>
    <div class="project-heading"><h2>{project.name}</h2><p>{project.archived ? 'Archived' : latest ? `Last check-in ${new Date(latest.createdAt).toLocaleDateString()}` : 'No check-in yet'}</p></div>
  </header>
  {#if project.description}<p class="description">{project.description}</p>{/if}
  <dl class="ratings"><div><dt>Work complete</dt><dd>{latest ? `${latest.progress}%` : 'Not set'}</dd></div><div><dt>Heart in it</dt><dd>{latest ? `${latest.heart}%` : 'Not set'}</dd></div></dl>
  {#if !project.archived}
    {#if checkingIn}
      <form class="check-in" on:submit|preventDefault={save}>
        <div class="rating-control"><span>Work complete</span><ProbabilitySlider value={progress ?? 0} unset={progress === null} ariaLabel={`Work complete for ${project.name}`} onChange={(value) => progress = value} generousHitbox /></div>
        <div class="rating-control"><span>Heart in it</span><ProbabilitySlider value={heart ?? 0} unset={heart === null} ariaLabel={`Heart in it for ${project.name}`} onChange={(value) => heart = value} generousHitbox /></div>
        <div class="actions"><button class="primary" type="submit" disabled={progress === null || heart === null}>Save check-in</button><button class="ghost" type="button" on:click={() => checkingIn = false}>Cancel</button></div>
      </form>
    {:else}<button class="check-in-button" type="button" on:click={openCheckIn}>Check in</button>{/if}
    {#if saved}<span class="muted" role="status">{saved}</span>{/if}
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
  {/if}
  <footer><button class="ghost" type="button" on:click={() => copyLink(project.id)}>Copy project link</button><button class="ghost" type="button" on:click={() => editing = !editing}>{editing ? 'Close details' : 'Edit details'}</button></footer>
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
  .ratings { display: flex; flex-wrap: wrap; gap: 24px; margin: 0; font-size: 13px; }
  .ratings div { display: flex; gap: 8px; } dt { color: var(--muted); } dd { margin: 0; font-variant-numeric: tabular-nums; }
  .check-in-button { justify-self: start; }
  .check-in { display: grid; gap: 16px; border-top: 1px solid var(--line); padding-top: 12px; }
  .rating-control { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 12px; font-size: 13px; }
  .actions, footer { display: flex; flex-wrap: wrap; gap: 8px; }
  summary { cursor: pointer; font-size: 13px; }
  .endpoints, .legend { display: flex; justify-content: space-between; gap: 8px; font-size: 12px; color: var(--muted); }
  .legend { margin-top: 12px; }
  .history-chart { width: 100%; max-height: 160px; color: var(--project-color); }
  .grid { stroke: var(--line); fill: none; }
  .history-table { max-height: 180px; overflow: auto; margin-top: 12px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { text-align: left; padding: 6px 3px; border-bottom: 1px solid var(--line); }
  .edit-details { display: grid; gap: 12px; border-top: 1px solid var(--line); padding-top: 12px; }
  .edit-details label { display: grid; gap: 6px; font-size: 13px; }
  textarea { width: 100%; box-sizing: border-box; resize: vertical; background: var(--paper-strong); color: var(--ink); border: 1px solid var(--line); border-radius: 6px; padding: 8px 10px; }
</style>
