<script lang="ts">
  import { onMount } from 'svelte'
  import PlanItemEditor from './lib/PlanItemEditor.svelte'
  import TemplateItemEditor from './lib/TemplateItemEditor.svelte'
  import { confirmRecoveryKey, exportHTML, exportJSON, getRecoveryKeyStatus, plannerStore } from './lib/store'
  import type { RecoveryKeyStatus } from './lib/store'
  import { formatPlanTitle, todayISO } from './lib/planner'

  type View = 'today' | 'templates' | 'history' | 'export'

  let view: View = 'today'
  let selectedTemplateId = ''
  let recoveryKeyStatus: RecoveryKeyStatus | null = null
  let recoveryKeySaved = false
  let recoveryKeyCopied = false

  $: templates = $plannerStore.templates
  $: activePlan = $plannerStore.plans.find((plan) => plan.date === $plannerStore.activePlanDate)
  $: selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0]
  $: if (!selectedTemplateId && templates[0]) selectedTemplateId = templates[0].id
  $: generateButtonLabel = $plannerStore.activePlanDate === todayISO() ? 'Generate today' : 'Generate selected day'

  onMount(async () => {
    recoveryKeyStatus = await getRecoveryKeyStatus()
  })

  function generateSelectedDay() {
    if (!selectedTemplate) return

    const date = $plannerStore.activePlanDate || todayISO()
    const exists = $plannerStore.plans.some((plan) => plan.date === date)
    const replaceExisting = exists
      ? window.confirm('This date already has a plan. Replace it with a freshly generated one?')
      : false

    if (exists && !replaceExisting) {
      plannerStore.setActivePlanDate(date)
      view = 'today'
      return
    }

    plannerStore.generatePlan(selectedTemplate.id, date, replaceExisting)
    view = 'today'
  }

  function download(filename: string, content: string, type: string) {
    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  function downloadJSON() {
    download(`balance-export-${todayISO()}.json`, exportJSON($plannerStore), 'application/json')
  }

  function downloadHTML() {
    download(`balance-history-${todayISO()}.html`, exportHTML($plannerStore), 'text/html')
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    const key = event.key.toLowerCase()
    const primaryModifier = event.metaKey || event.ctrlKey

    if (!primaryModifier || event.altKey) return

    if (key === 'z' && !event.shiftKey) {
      event.preventDefault()
      void plannerStore.undo()
      return
    }

    if (event.shiftKey && (key === 'z' || key === 'c')) {
      event.preventDefault()
      void plannerStore.redo()
    }
  }

  async function copyRecoveryKey() {
    if (!recoveryKeyStatus?.recoveryKey) return

    await navigator.clipboard.writeText(recoveryKeyStatus.recoveryKey)
    recoveryKeyCopied = true
  }

  async function finishRecoveryKeySetup() {
    await confirmRecoveryKey()
    recoveryKeyStatus = await getRecoveryKeyStatus()
    recoveryKeySaved = false
  }
</script>

<svelte:window on:keydown|capture={handleGlobalKeydown} />

<main class="app-shell">
  <aside class="sidebar">
    <div>
      <h1>Balance</h1>
      <p class="muted">Local-first daily planning</p>
    </div>

    <nav aria-label="Primary">
      <button class:active={view === 'today'} type="button" on:click={() => (view = 'today')}>Today</button>
      <button class:active={view === 'templates'} type="button" on:click={() => (view = 'templates')}>Templates</button>
      <button class:active={view === 'history'} type="button" on:click={() => (view = 'history')}>History</button>
      <button class:active={view === 'export'} type="button" on:click={() => (view = 'export')}>Export</button>
    </nav>

    <div class="sidebar-footer">
      <button class="primary" type="button" on:click={generateSelectedDay}>{generateButtonLabel}</button>
      <p class="tiny">{templates.length} template · {$plannerStore.plans.length} saved days</p>
    </div>
  </aside>

  <section class="workspace">
    {#if view === 'today'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Daily plan</p>
          <h2>
            {activePlan?.title ?? formatPlanTitle($plannerStore.activePlanDate)}
            <span class="daily-reminder">— This shouldn't be aspirational</span>
          </h2>
        </div>
        <input
          class="date-input"
          type="date"
          value={$plannerStore.activePlanDate}
          on:input={(event) => plannerStore.setActivePlanDate(event.currentTarget.value)}
        />
      </header>

      {#if activePlan}
        <div class="list-panel">
          {#if activePlan.items.length === 0}
            <p class="empty">No items yet.</p>
          {/if}

          {#each activePlan.items as item (item.id)}
            <PlanItemEditor
              {item}
              planId={activePlan.id}
              patchItem={plannerStore.patchPlanItem}
              splitItem={plannerStore.splitPlanItem}
              addChild={plannerStore.addPlanChild}
              deleteItem={plannerStore.deletePlanItem}
              moveItem={plannerStore.movePlanItem}
              moveItemWithinLevel={plannerStore.movePlanItemWithinLevel}
              historyRevision={$plannerStore.historyRevision}
            />
          {/each}

          <button class="add-row" type="button" on:click={() => plannerStore.addRootPlanItem(activePlan.id)}>
            + Add item
          </button>
        </div>
      {:else}
        <div class="empty-state">
          <h3>No plan for this date</h3>
          <p>Generate one from the template, or switch to a saved day in History.</p>
          <button class="primary" type="button" on:click={generateSelectedDay}>{generateButtonLabel}</button>
        </div>
      {/if}
    {/if}

    {#if view === 'templates'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Generator</p>
          <h2>Daily template</h2>
        </div>
        {#if selectedTemplate}
          <select bind:value={selectedTemplateId} aria-label="Select template">
            {#each templates as template (template.id)}
              <option value={template.id}>{template.name}</option>
            {/each}
          </select>
        {/if}
      </header>

      {#if selectedTemplate}
        <div class="template-panel">
          <label class="field-label" for="template-name">Template name</label>
          <input
            id="template-name"
            class="title-input"
            value={selectedTemplate.name}
            on:input={(event) => plannerStore.renameTemplate(selectedTemplate.id, event.currentTarget.value)}
          />

          <div class="template-list">
            {#each selectedTemplate.items as item (item.id)}
              <TemplateItemEditor
                {item}
                templateId={selectedTemplate.id}
                patchItem={plannerStore.patchTemplateItem}
                deleteItem={plannerStore.deleteTemplateItem}
                moveItem={plannerStore.moveTemplateItem}
                addChild={plannerStore.addTemplateChild}
                addOption={plannerStore.addTemplateOption}
                patchOption={plannerStore.patchTemplateOption}
                deleteOption={plannerStore.deleteTemplateOption}
                historyRevision={$plannerStore.historyRevision}
              />
            {/each}
          </div>

          <button class="add-row" type="button" on:click={() => plannerStore.addRootTemplateItem(selectedTemplate.id)}>
            + Add template item
          </button>
        </div>
      {/if}
    {/if}

    {#if view === 'history'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Archive</p>
          <h2>Saved days</h2>
        </div>
      </header>

      <div class="history-grid">
        {#each $plannerStore.plans as plan (plan.id)}
          <button
            class="history-card"
            type="button"
            on:click={() => {
              plannerStore.setActivePlanDate(plan.date)
              view = 'today'
            }}
          >
            <strong>{plan.title}</strong>
            <span>{plan.date}</span>
            <small>{plan.items.length} top-level items</small>
          </button>
        {:else}
          <p class="empty">Generated plans will show up here.</p>
        {/each}
      </div>
    {/if}

    {#if view === 'export'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Portability</p>
          <h2>Export everything</h2>
        </div>
      </header>

      <div class="export-panel">
        <div>
          <h3>Canonical JSON</h3>
          <p>Full app state, including templates, generated plans, and the operation log.</p>
          <button class="primary" type="button" on:click={downloadJSON}>Export JSON</button>
        </div>

        <div>
          <h3>Readable HTML</h3>
          <p>A simple history document with every saved daily plan.</p>
          <button type="button" on:click={downloadHTML}>Export HTML</button>
        </div>
      </div>
    {/if}
  </section>
</main>

{#if recoveryKeyStatus?.recoveryKey}
  <div class="modal-backdrop">
    <div class="recovery-dialog" role="dialog" aria-modal="true" aria-labelledby="recovery-title">
      <p class="eyebrow">Encryption</p>
      <h2 id="recovery-title">Save your recovery key</h2>
      <p class="recovery-copy">
        This key unlocks your encrypted Balance database from a backup or another device. Keep it somewhere private;
        Balance cannot recover it for you.
      </p>

      <div class="recovery-key" aria-label="Recovery key">{recoveryKeyStatus.recoveryKey}</div>

      <div class="recovery-actions">
        <button type="button" on:click={copyRecoveryKey}>{recoveryKeyCopied ? 'Copied' : 'Copy key'}</button>
        <label class="confirm-line">
          <input type="checkbox" bind:checked={recoveryKeySaved} />
          <span>I saved this recovery key somewhere safe.</span>
        </label>
        <button class="primary" type="button" disabled={!recoveryKeySaved} on:click={finishRecoveryKeySetup}>
          Continue
        </button>
      </div>

      <p class="database-path">Database: {recoveryKeyStatus.databasePath}</p>
    </div>
  </div>
{/if}
