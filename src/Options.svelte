<script>
    import { createEventDispatcher } from "svelte";
    import { THEME_PALETTES } from "./themes.js";
    import "./button.css";
    export let editingSettings;
    export let api;

    const dispatch = createEventDispatcher();

    $: trackedMissions = editingSettings.missions.filter(
        (m) => !m.deleted && !m.untracked,
    );
    $: deletedMissions = editingSettings.missions.filter((m) => m.deleted);
    $: otherMission = editingSettings.missions.find(
        (m) => m.untracked && !m.deleted,
    );
    $: totalPercent = trackedMissions.reduce(
        (sum, m) => sum + (m.targetPercent || 0),
        0,
    );
    $: percentWarning = Math.abs(totalPercent - 100) > 0.1;

    function addMission() {
        const newMission = {
            name: "New Mission",
            theme: "blue",
            targetPercent: 25,
            untracked: false,
            deleted: false,
        };
        // Insert before "Other" mission
        const otherIndex = editingSettings.missions.findIndex(
            (m) => m.untracked,
        );
        if (otherIndex !== -1) {
            editingSettings.missions.splice(otherIndex, 0, newMission);
        } else {
            editingSettings.missions.push(newMission);
        }
        editingSettings.missions = editingSettings.missions; // Trigger reactivity
    }

    function deleteMission(index) {
        editingSettings.missions[index].deleted = true;
        editingSettings.missions = editingSettings.missions; // Trigger reactivity
    }

    function restoreMission(index) {
        editingSettings.missions[index].deleted = false;
        editingSettings.missions = editingSettings.missions; // Trigger reactivity
    }

    function saveOptions() {
        api.saveSettings(editingSettings);
        dispatch("close");
    }

    function openDataFolder() {
        api.openDataFolder();
    }

    function quit() {
        api.quit();
    }
</script>

<div class="options root">
    <div class="sheet">
        <div class="title" style="text-align: center;"><h2>Options</h2></div>

        <!-- Tracked Missions -->
        <div class="section">
            <h3>Missions</h3>
            {#each editingSettings.missions as mission, i}
                {#if !mission.deleted && !mission.untracked}
                    <div class="mission-row">
                        <div class="mission-fields">
                            <div class="field">
                                <input
                                    bind:value={mission.name}
                                    placeholder="Mission name"
                                />
                            </div>
                            <div class="field-row">
                                <div class="field half">
                                    <select bind:value={mission.theme}>
                                        {#each Object.keys(THEME_PALETTES) as themeKey}
                                            <option value={themeKey}>
                                                {themeKey
                                                    .charAt(0)
                                                    .toUpperCase() +
                                                    themeKey.slice(1)}
                                            </option>
                                        {/each}
                                    </select>
                                </div>
                                <div class="field half">
                                    <input
                                        type="number"
                                        min="0"
                                        step="1"
                                        bind:value={mission.targetPercent}
                                        placeholder="%"
                                    />
                                </div>
                            </div>
                        </div>
                        <button
                            class="btn delete-btn"
                            on:click={() => deleteMission(i)}
                            title="Delete mission"
                        >
                            🗑️
                        </button>
                    </div>
                {/if}
            {/each}

            <button class="btn add-btn" on:click={addMission}>
                ➕ Add Mission
            </button>

            {#if percentWarning}
                <div class="warning">
                    ⚠️ Total: {Math.round(totalPercent)}% (will be normalized to
                    100%)
                </div>
            {:else}
                <div class="success">
                    ✓ Total: {Math.round(totalPercent)}%
                </div>
            {/if}
        </div>

        <!-- Trash Section -->
        {#if deletedMissions.length > 0}
            <details class="section">
                <summary>🗑️ Trash ({deletedMissions.length})</summary>
                <p class="hint">
                    Deleted missions are hidden but data is preserved
                </p>
                {#each editingSettings.missions as mission, i}
                    {#if mission.deleted}
                        <div class="trash-item">
                            <span>{mission.name}</span>
                            <button
                                class="btn restore-btn"
                                on:click={() => restoreMission(i)}
                            >
                                ↩️ Restore
                            </button>
                        </div>
                    {/if}
                {/each}
            </details>
        {/if}

        <!-- Other Settings -->
        <div class="section">
            <h3>Timer Settings</h3>
            <div class="field">
                <label>Acceptable balance range (hours)</label>
                <input
                    type="number"
                    min="0"
                    bind:value={editingSettings.acceptableHourRange}
                />
            </div>
            <div class="field-row">
                <div class="field half">
                    <label>Work length (minutes)</label>
                    <input
                        type="number"
                        min="1"
                        bind:value={editingSettings.durations.workMinutes}
                    />
                </div>
                <div class="field half">
                    <label>Break length (minutes)</label>
                    <input
                        type="number"
                        min="1"
                        bind:value={editingSettings.durations.breakMinutes}
                    />
                </div>
            </div>
        </div>

        <!-- Actions -->
        <div class="controls">
            <button
                class="btn"
                on:click={openDataFolder}
                style="background:#e1f5fe"
                title="Open data folder"
            >
                📁 Data Folder
            </button>
            <button class="btn" on:click={quit} style="background:#ffcccb">
                Quit App
            </button>
        </div>
        <div class="controls">
            <button
                class="btn"
                on:click={saveOptions}
                style="background:#d6ffd9"
            >
                Save & Close
            </button>
        </div>
    </div>
</div>

<style>
    .options {
        position: absolute;
        inset: 0;
        background: rgba(0, 0, 0, 0.15);
        display: flex;
        align-items: center;
        justify-content: center;
        overflow-y: auto;
    }
    .sheet {
        width: calc(100% - 24px);
        max-width: 340px;
        max-height: 90vh;
        overflow-y: auto;
        background: var(--card);
        border: 3px solid var(--stroke);
        border-radius: 16px;
        padding: 12px;
        box-sizing: border-box;
        margin: 20px 0;
    }
    .section {
        margin: 16px 0;
        padding: 8px 0;
    }
    .section h3 {
        margin: 4px 0 8px 0;
        font-size: 14px;
        font-weight: 600;
        color: var(--stroke);
    }
    .field {
        margin: 4px 0;
    }
    .field-row {
        display: flex;
        gap: 8px;
    }
    .field.half {
        flex: 1;
    }
    input,
    select {
        width: 100%;
        padding: 8px 10px;
        border: 3px solid var(--stroke);
        border-radius: 10px;
        background: #fff;
        box-sizing: border-box;
        font-size: 14px;
    }
    input:disabled {
        background: #f5f5f5;
        color: #999;
    }
    .mission-row {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        margin-bottom: 12px;
    }
    .mission-fields {
        flex: 1;
    }
    .delete-btn {
        padding: 8px;
        min-width: 40px;
        margin-top: 4px;
    }
    .add-btn {
        width: 100%;
        margin-top: 8px;
    }
    .warning {
        text-align: center;
        color: #ff6b00;
        font-size: 12px;
        margin-top: 8px;
        font-weight: 600;
    }
    .success {
        text-align: center;
        color: #2e7d32;
        font-size: 12px;
        margin-top: 8px;
        font-weight: 600;
    }
    .hint {
        font-size: 11px;
        color: #666;
        margin: 4px 0;
    }
    details {
        cursor: pointer;
    }
    summary {
        font-weight: 600;
        padding: 4px 0;
        user-select: none;
    }
    .trash-item {
        display: flex;
        justify-content: space-between;
        align-items: center;
        padding: 8px;
        margin: 4px 0;
        background: #f5f5f5;
        border-radius: 8px;
    }
    .trash-item span {
        color: #999;
        text-decoration: line-through;
    }
    .restore-btn {
        padding: 4px 8px;
        font-size: 12px;
    }
    .controls {
        display: flex;
        gap: 8px;
        justify-content: center;
        align-items: center;
        text-align: center;
        margin-top: 10px;
        flex-wrap: wrap;
    }
</style>
