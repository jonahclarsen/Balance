<script>
    import { createEventDispatcher } from "svelte";
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
    function quit() {
        api.quit();
    }
</script>

<div class="options root">
    <div class="sheet">
        <div class="title">Options</div>
        <div class="field">
            <label>Pink Mission Name</label>
            <input bind:value={editingSettings.missions[0].name} />
        </div>
        <div class="field">
            <label>Green Mission Name</label>
            <input bind:value={editingSettings.missions[1].name} />
        </div>
        <div class="field">
            <label>Untracked Mission Name</label>
            <input bind:value={editingSettings.missions[2].name} />
        </div>
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
        <div class="controls">
            <button
                class="btn"
                on:click={openDataFolder}
                style="background:#e1f5fe"
                title="Open data folder"
            >
                📁 Open Data Folder
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
                Close
            </button>
        </div>
    </div>
</div>

<style>
    .options {
        position: absolute;
        inset: 0;
        background: rgba(255, 248, 231, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .sheet {
        width: calc(100% - 24px);
        max-width: 320px;
        background: var(--card);
        border: 3px solid var(--stroke);
        border-radius: 16px;
        padding: 12px;
        box-sizing: border-box;
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
    input {
        width: 100%;
        padding: 8px 10px;
        border: 3px solid var(--stroke);
        border-radius: 10px;
        background: #fff;
        box-sizing: border-box;
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
