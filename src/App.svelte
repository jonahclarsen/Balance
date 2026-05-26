<script lang="ts">
  import { invoke, isTauri } from '@tauri-apps/api/core'
  import { confirm as confirmDialog, open as openDialog } from '@tauri-apps/plugin-dialog'
  import { onMount, tick } from 'svelte'
  import PlanItemEditor from './lib/PlanItemEditor.svelte'
  import TemplateItemEditor from './lib/TemplateItemEditor.svelte'
  import { confirmRecoveryKey, exportHTML, exportJSON, getRecoveryKeyStatus, plannerStore } from './lib/store'
  import type { RecoveryKeyStatus } from './lib/store'
  import type { PlanItem } from './lib/types'
  import { DEFAULT_DAILY_REMINDER, formatPlanTitle, todayISO } from './lib/planner'

  type View = 'today' | 'templates' | 'history' | 'export' | 'settings'
  type ExportSettings = {
    exportDirectory: string
    defaultExportDirectory: string
    usesDefaultExportDirectory: boolean
  }

  let view: View = 'today'
  let selectedTemplateId = ''
  let recoveryKeyStatus: RecoveryKeyStatus | null = null
  let recoveryKeySaved = false
  let recoveryKeyCopied = false
  let exportStatus = ''
  let exportStatusIsError = false
  let exportSavedPath = ''
  let exportSettings: ExportSettings | null = null
  let exportSettingsStatus = ''
  let exportSettingsStatusIsError = false
  let exportSettingsBusy = false
  let editingDailyReminder = false
  let dailyReminderDraft = ''
  let dailyReminderInput: HTMLInputElement | null = null

  $: templates = $plannerStore.templates
  $: activePlan = $plannerStore.plans.find((plan) => plan.date === $plannerStore.activePlanDate)
  $: activeDailyReminder = activePlan?.dailyReminder ?? DEFAULT_DAILY_REMINDER
  $: if (!editingDailyReminder) dailyReminderDraft = activeDailyReminder
  $: selectedTemplate = templates.find((template) => template.id === selectedTemplateId) ?? templates[0]
  $: if (!selectedTemplateId && templates[0]) selectedTemplateId = templates[0].id
  $: generateButtonLabel = $plannerStore.activePlanDate === todayISO() ? 'Generate today' : 'Generate selected day'

  onMount(async () => {
    recoveryKeyStatus = await getRecoveryKeyStatus()
    await loadExportSettings()
  })

  function shiftActivePlanDate(days: number) {
    plannerStore.setActivePlanDate(shiftISODate($plannerStore.activePlanDate || todayISO(), days))
  }

  function shiftISODate(date: string, days: number): string {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date)
    if (!match) return todayISO()

    const shifted = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + days)
    const year = shifted.getFullYear()
    const month = String(shifted.getMonth() + 1).padStart(2, '0')
    const day = String(shifted.getDate()).padStart(2, '0')
    return `${year}-${month}-${day}`
  }

  async function confirmReplaceExistingPlan(): Promise<boolean> {
    const message = 'This date already has a plan. Replace it with a freshly generated one?'

    if (isTauri()) {
      return confirmDialog(message, { title: 'Replace existing plan?', kind: 'warning' })
    }

    return window.confirm(message)
  }

  async function generateSelectedDay() {
    if (!selectedTemplate) return

    const date = $plannerStore.activePlanDate || todayISO()
    const exists = $plannerStore.plans.some((plan) => plan.date === date)
    const replaceExisting = exists ? await confirmReplaceExistingPlan() : false

    if (exists && !replaceExisting) {
      plannerStore.setActivePlanDate(date)
      view = 'today'
      return
    }

    plannerStore.generatePlan(selectedTemplate.id, date, replaceExisting)
    view = 'today'
  }

  async function download(filename: string, content: string, type: string) {
    exportStatus = ''
    exportStatusIsError = false
    exportSavedPath = ''

    if (isTauri()) {
      try {
        const savedPath = await invoke<string>('save_export_file', { filename, content })
        exportSavedPath = savedPath
      } catch (error) {
        exportStatusIsError = true
        exportStatus = error instanceof Error ? error.message : String(error)
      }
      return
    }

    const blob = new Blob([content], { type })
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = filename
    document.body.append(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
    exportStatus = `Download started for ${filename}`
  }

  async function revealSavedExport() {
    if (!exportSavedPath) return

    exportStatus = ''
    exportStatusIsError = false

    try {
      await invoke('reveal_path_in_file_manager', { path: exportSavedPath })
    } catch (error) {
      exportStatusIsError = true
      exportStatus = error instanceof Error ? error.message : String(error)
    }
  }

  function downloadJSON() {
    void download(`balance-export-${todayISO()}.json`, exportJSON($plannerStore), 'application/json')
  }

  function downloadHTML() {
    void download(`balance-history-${todayISO()}.html`, exportHTML($plannerStore), 'text/html')
  }

  async function loadExportSettings() {
    if (!isTauri()) return

    try {
      exportSettings = await invoke<ExportSettings>('get_export_settings')
    } catch (error) {
      exportSettingsStatusIsError = true
      exportSettingsStatus = error instanceof Error ? error.message : String(error)
    }
  }

  async function chooseExportDirectory() {
    if (!isTauri()) return

    exportSettingsStatus = ''
    exportSettingsStatusIsError = false
    exportSettingsBusy = true

    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: 'Choose export folder',
        defaultPath: exportSettings?.exportDirectory,
      })

      if (typeof selected === 'string') {
        exportSettings = await invoke<ExportSettings>('set_export_directory', { directory: selected })
        exportSettingsStatus = `Exports save to ${exportSettings.exportDirectory}`
      }
    } catch (error) {
      exportSettingsStatusIsError = true
      exportSettingsStatus = error instanceof Error ? error.message : String(error)
    } finally {
      exportSettingsBusy = false
    }
  }

  async function resetExportDirectory() {
    if (!isTauri()) return

    exportSettingsStatus = ''
    exportSettingsStatusIsError = false
    exportSettingsBusy = true

    try {
      exportSettings = await invoke<ExportSettings>('reset_export_directory')
      exportSettingsStatus = `Exports save to ${exportSettings.exportDirectory}`
    } catch (error) {
      exportSettingsStatusIsError = true
      exportSettingsStatus = error instanceof Error ? error.message : String(error)
    } finally {
      exportSettingsBusy = false
    }
  }

  function handleGlobalKeydown(event: KeyboardEvent) {
    const key = event.key.toLowerCase()
    const primaryModifier = event.metaKey || event.ctrlKey

    if (view === 'today' && event.altKey && !primaryModifier && !event.shiftKey) {
      if (event.code === 'KeyQ') {
        event.preventDefault()
        shiftActivePlanDate(-1)
        return
      }

      if (event.code === 'KeyW') {
        event.preventDefault()
        shiftActivePlanDate(1)
        return
      }
    }

    if (!primaryModifier || event.altKey) return

    if (key === 'd' && !event.shiftKey) {
      const itemId = activeFocusedPlanItemId()
      const item = itemId && activePlan ? findPlanItem(activePlan.items, itemId) : null
      if (!activePlan || !item) return

      event.preventDefault()
      plannerStore.patchPlanItem(activePlan.id, item.id, { done: !item.done })
      return
    }

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

  function activeFocusedPlanItemId(): string | null {
    if (view !== 'today') return null

    const active = document.activeElement
    const row = active instanceof Element ? active.closest<HTMLElement>('[data-plan-item-id]') : null
    return row?.dataset.planItemId ?? null
  }

  function findPlanItem(items: PlanItem[], itemId: string): PlanItem | null {
    for (const item of items) {
      if (item.id === itemId) return item
      const child = findPlanItem(item.children, itemId)
      if (child) return child
    }

    return null
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

  async function startDailyReminderEdit() {
    if (!activePlan) return

    dailyReminderDraft = activePlan.dailyReminder
    editingDailyReminder = true
    await tick()
    dailyReminderInput?.focus()
    dailyReminderInput?.select()
  }

  function updateDailyReminder(value: string) {
    dailyReminderDraft = value
    if (activePlan) plannerStore.patchPlanDailyReminder(activePlan.id, value)
  }

  function handleDailyReminderKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault()
      dailyReminderInput?.blur()
    }
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
      <button class:active={view === 'settings'} type="button" on:click={() => (view = 'settings')}>Settings</button>
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
            {#if editingDailyReminder && activePlan}
              <span class="daily-reminder-prefix">—</span>
              <input
                bind:this={dailyReminderInput}
                class="daily-reminder-input"
                aria-label="Edit daily reminder"
                value={dailyReminderDraft}
                on:input={(event) => updateDailyReminder(event.currentTarget.value)}
                on:blur={() => (editingDailyReminder = false)}
                on:keydown={handleDailyReminderKeydown}
              />
            {:else}
              <button
                class="daily-reminder-button"
                type="button"
                title={activePlan ? 'Edit daily reminder' : 'Generate a day before editing the reminder'}
                on:click={startDailyReminderEdit}
              >
                — {activeDailyReminder}
              </button>
            {/if}
          </h2>
        </div>
        <div class="date-controls" aria-label="Day navigation">
          <button
            class="date-nav-button"
            type="button"
            aria-label="Previous day"
            title="Previous day (Option+Q)"
            on:click={() => shiftActivePlanDate(-1)}
          >
            &lt;
          </button>
          <button
            class="date-nav-button"
            type="button"
            aria-label="Next day"
            title="Next day (Option+W)"
            on:click={() => shiftActivePlanDate(1)}
          >
            &gt;
          </button>
          <input
            class="date-input"
            type="date"
            value={$plannerStore.activePlanDate}
            on:input={(event) => plannerStore.setActivePlanDate(event.currentTarget.value)}
          />
        </div>
      </header>

      {#if activePlan}
        <div class="list-panel">
          {#if activePlan.items.length === 0}
            <p class="empty">No items yet.</p>
          {/if}

          {#each activePlan.items as item (item.id)}
            <PlanItemEditor
              {item}
              allItems={activePlan.items}
              planId={activePlan.id}
              patchItem={plannerStore.patchPlanItem}
              splitItem={plannerStore.splitPlanItem}
              addChild={plannerStore.addPlanChild}
              deleteItem={plannerStore.deletePlanItem}
              moveItem={plannerStore.movePlanItem}
              moveItemWithinLevel={plannerStore.movePlanItemWithinLevel}
              outdentItem={plannerStore.outdentPlanItem}
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
                allItems={selectedTemplate.items}
                templateId={selectedTemplate.id}
                patchItem={plannerStore.patchTemplateItem}
                splitItem={plannerStore.splitTemplateItem}
                deleteItem={plannerStore.deleteTemplateItem}
                moveItem={plannerStore.moveTemplateItem}
                moveItemWithinLevel={plannerStore.moveTemplateItemWithinLevel}
                outdentItem={plannerStore.outdentTemplateItem}
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

      {#if exportStatusIsError && exportStatus}
        <p class:error={exportStatusIsError} class="export-status">{exportStatus}</p>
      {:else if exportSavedPath}
        <p class="export-status">
          Saved to
          <button class="path-link" type="button" on:click={revealSavedExport}>{exportSavedPath}</button>
        </p>
      {:else if exportStatus}
        <p class:error={exportStatusIsError} class="export-status">{exportStatus}</p>
      {/if}
    {/if}

    {#if view === 'settings'}
      <header class="page-header">
        <div>
          <p class="eyebrow">Preferences</p>
          <h2>Settings</h2>
        </div>
      </header>

      <div class="settings-panel">
        <section class="settings-section">
          <div>
            <h3>Export folder</h3>
            {#if isTauri()}
              <p>
                {exportSettings?.usesDefaultExportDirectory
                  ? 'Using the default downloads folder.'
                  : 'Using a custom folder.'}
              </p>
            {:else}
              <p>Browser preview exports use the browser download location.</p>
            {/if}
          </div>

          <div class="path-row">
            <span>{exportSettings?.exportDirectory ?? 'Browser downloads'}</span>
          </div>

          {#if isTauri()}
            <div class="settings-actions">
              <button class="primary" type="button" disabled={exportSettingsBusy} on:click={chooseExportDirectory}>
                Choose folder
              </button>
              <button
                type="button"
                disabled={exportSettingsBusy || Boolean(exportSettings?.usesDefaultExportDirectory)}
                on:click={resetExportDirectory}
              >
                Reset to downloads
              </button>
            </div>
          {/if}
        </section>
      </div>

      {#if exportSettingsStatus}
        <p class:error={exportSettingsStatusIsError} class="export-status">{exportSettingsStatus}</p>
      {/if}
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
