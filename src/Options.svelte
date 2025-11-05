<script>
    import { createEventDispatcher } from "svelte";
    import { THEME_PALETTES } from "./themes.js";
    import "./button.css";
    export let editingSettings;
    export let api;

    const dispatch = createEventDispatcher();

    function saveOptions() {
        api.saveSettings(editingSettings);
        dispatch("close");
    }

    function openDataFolder() {
        api.openDataFolder();
    }

    function openGithub() {
        api.openGithub();
    }

    function quit() {
        api.quit();
    }
</script>

<div class="options root">
    <div class="sheet">
        <div class="title" style="text-align: center;"><h2>Options</h2></div>

        <!-- Theme Settings -->
        <div class="section">
            <h3>Theme</h3>
            <div class="field">
                <select bind:value={editingSettings.theme}>
                    {#each Object.keys(THEME_PALETTES) as themeKey}
                        <option value={themeKey}>
                            {themeKey.charAt(0).toUpperCase() +
                                themeKey.slice(1)}
                        </option>
                    {/each}
                </select>
            </div>
        </div>

        <!-- Timer Settings -->
        <div class="section">
            <h3>Timer Settings</h3>
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
            <button
                class="btn"
                on:click={openGithub}
                style="background:#f0f0f0"
                title="Open GitHub repository"
            >
                🔗 GitHub
            </button>
            <button class="btn" on:click={quit} style="background:#ffcccb">
                Quit App
            </button>
            <button
                class="btn"
                on:click={saveOptions}
                style="background:#d6ffd9"
            >
                Save & Close Options
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
        max-width: 300px;
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
