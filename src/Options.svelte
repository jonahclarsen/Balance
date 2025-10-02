<script>
    import { createEventDispatcher } from "svelte";
    import "./button.css";
    export let editingSettings;
    export let api;

    const dispatch = createEventDispatcher();

    function saveOptions() {
        // Ensure goals sum to 100 (excluding zero-goal items) by proportional normalization
        try {
            const goals = (editingSettings.missions || []).map((m) => Number(m.goalPercent) || 0);
            const positiveSum = goals.filter((g) => g > 0).reduce((a, b) => a + b, 0);
            if (positiveSum > 0) {
                editingSettings.missions = (editingSettings.missions || []).map((m) => {
                    const g = Number(m.goalPercent) || 0;
                    return { ...m, goalPercent: g > 0 ? Math.round((g / positiveSum) * 100) : 0 };
                });
                // Adjust rounding drift to exactly 100
                let drift = 100 - editingSettings.missions.filter(m => (m.goalPercent || 0) > 0).reduce((s, m) => s + m.goalPercent, 0);
                if (drift !== 0) {
                    // Add/subtract drift to the largest-goal mission to satisfy exact sum
                    const idx = editingSettings.missions
                        .map((m, i) => ({ i, g: m.goalPercent || 0 }))
                        .filter(x => x.g > 0)
                        .sort((a, b) => b.g - a.g)[0]?.i;
                    if (typeof idx === 'number') editingSettings.missions[idx].goalPercent += drift;
                }
            }
        } catch {}
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
        <div class="field">
            <label>Purposes</label>
            <div class="repeater">
                {#each editingSettings.missions as m, i}
                    <div class="row-item">
                        <input class="name" placeholder="Name" bind:value={m.name} />
                        <select class="scheme" bind:value={m.scheme}>
                            <option value="pink">Pink</option>
                            <option value="green">Green</option>
                            <option value="blue">Blue</option>
                            <option value="purple">Purple</option>
                            <option value="orange">Orange</option>
                            <option value="teal">Teal</option>
                            <option value="indigo">Indigo</option>
                            <option value="gold">Gold</option>
                            <option value="neutral">Neutral</option>
                        </select>
                        <input class="color" type="color" bind:value={m.color} />
                        <input class="goal" type="number" min="0" max="100" bind:value={m.goalPercent} />
                        <button class="btn small" title="Remove" on:click={() => editingSettings.missions.splice(i, 1)}>✖</button>
                    </div>
                {/each}
                <div class="row-item">
                    <button class="btn" on:click={() => {
                        (editingSettings.missions || (editingSettings.missions = [])).push({ name: 'New Purpose', color: '#607d8b', scheme: 'neutral', goalPercent: 0 });
                    }}>➕ Add Purpose</button>
                </div>
            </div>
            <div class="hint">Goals > 0 are included in recovery and normalized to 100%.</div>
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
    .repeater {
        display: flex;
        flex-direction: column;
        gap: 6px;
    }
    .row-item {
        display: grid;
        grid-template-columns: 1fr 1fr 60px 70px 34px;
        gap: 6px;
        align-items: center;
    }
    .row-item .name { grid-column: 1; }
    .row-item .scheme { grid-column: 2; }
    .row-item .color { grid-column: 3; height: 36px; padding: 0; }
    .row-item .goal { grid-column: 4; }
    .row-item .btn.small { grid-column: 5; padding: 6px 8px; }
    .hint { font-size: 11px; color: var(--gray); margin-top: 6px; }
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
