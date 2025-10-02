<script>
    import { createEventDispatcher } from "svelte";
    import "./button.css";
    export let editingSettings;
    export let api;

    const dispatch = createEventDispatcher();

    function saveOptions() {
        normalizeGoals();
        api.saveSettings(editingSettings);
        dispatch("close");
    }
    function normalizeGoals() {
        const goals = (editingSettings.missions || []).map((m) => Number(m.goalPercent || 0));
        const sum = goals.reduce((a, b) => a + b, 0);
        if (sum === 100 || sum === 0) return;
        // Renormalize to 100%
        for (let i = 0; i < editingSettings.missions.length; i++) {
            const g = Number(editingSettings.missions[i].goalPercent || 0);
            editingSettings.missions[i].goalPercent = Math.round((g / sum) * 100);
        }
        // Fix rounding drift
        let fix = 100 - editingSettings.missions.reduce((a, m) => a + (Number(m.goalPercent) || 0), 0);
        if (fix !== 0 && editingSettings.missions.length > 0) {
            editingSettings.missions[0].goalPercent = Math.max(0, (Number(editingSettings.missions[0].goalPercent) || 0) + fix);
        }
    }

    function addPurpose() {
        editingSettings.missions.push({ name: "New Purpose", color: "#607d8b", scheme: "slate", goalPercent: 0 });
    }
    function removePurpose(i) {
        if (editingSettings.missions.length <= 1) return;
        editingSettings.missions.splice(i, 1);
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
        <div class="purposes">
            {#each editingSettings.missions as m, i}
                <div class="purpose">
                    <div class="field-row">
                        <div class="field half">
                            <label for={`name_${i}`}>Purpose Name</label>
                            <input id={`name_${i}`} bind:value={m.name} />
                        </div>
                        <div class="field half">
                            <label for={`goal_${i}`}>Goal %</label>
                            <input id={`goal_${i}`} type="number" min="0" max="100" bind:value={m.goalPercent} />
                        </div>
                    </div>
                    <div class="field-row">
                        <div class="field half">
                            <label for={`color_${i}`}>Color</label>
                            <input id={`color_${i}`} type="color" bind:value={m.color} />
                        </div>
                        <div class="field half">
                            <label for={`scheme_${i}`}>Scheme</label>
                            <select id={`scheme_${i}`} bind:value={m.scheme}>
                                <option value="pink">Pink</option>
                                <option value="green">Green</option>
                                <option value="blue">Blue</option>
                                <option value="purple">Purple</option>
                                <option value="amber">Amber</option>
                                <option value="teal">Teal</option>
                                <option value="crimson">Crimson</option>
                                <option value="slate">Slate</option>
                                <option value="neutral">Neutral</option>
                            </select>
                        </div>
                    </div>
                    <div class="controls right">
                        <button class="btn" on:click={() => removePurpose(i)} style="background:#ffe0e0">Remove</button>
                    </div>
                    <hr />
                </div>
            {/each}
            <div class="controls">
                <button class="btn" on:click={addPurpose} style="background:#e1f5fe">+ Add Purpose</button>
            </div>
        </div>
        <div class="field">
            <label for="acc_range">Acceptable balance range (hours)</label>
            <input id="acc_range" type="number" min="0" bind:value={editingSettings.acceptableHourRange} />
        </div>
        <div class="field-row">
            <div class="field half">
                <label for="work_len">Work length (minutes)</label>
                <input id="work_len" type="number" min="1" bind:value={editingSettings.durations.workMinutes} />
            </div>
            <div class="field half">
                <label for="break_len">Break length (minutes)</label>
                <input id="break_len" type="number" min="1" bind:value={editingSettings.durations.breakMinutes} />
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
        background: rgba(0, 0, 0, 0.15);
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
    .right { justify-content: flex-end; }
    .field.half {
        flex: 1;
    }
    .purposes .purpose hr { border: 0; border-top: 2px dashed var(--stroke); margin: 8px 0; }
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
