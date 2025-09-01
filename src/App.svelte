<script>
    import { onMount } from "svelte";

    const api = window.balance;

    let settings = null;
    let state = null;
    let computed = null;
    let hasEnded = false;
    let showOptions = false;
    let editingSettings = null;

    function applyIncoming(payload) {
        settings = payload.settings;
        state = payload.state;
        computed = payload.computed;
    }

    onMount(async () => {
        const initial = await api.getState();
        applyIncoming(initial);
        const unsub = api.onState(({ type, payload }) => {
            applyIncoming(payload);
            if (type === "timer-ended") {
                hasEnded = true;
                new Audio(
                    "data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEAESsAACJWAAACABYBHQAA",
                )
                    .play()
                    .catch(() => {});
            }
        });
        return () => unsub && unsub();
    });

    function minutesLeft() {
        if (!state) return 0;
        return Math.floor((state.timer?.remainingSeconds || 0) / 60);
    }

    function extendBy(seconds) {
        api.extend(seconds);
    }

    function startWork() {
        hasEnded = false;
        api.startWork();
    }
    function startBreak() {
        hasEnded = false;
        api.startBreak();
    }
    function stop() {
        api.stop();
    }
    function switchMission(i) {
        api.switchMission(i);
    }

    function openOptions() {
        editingSettings = JSON.parse(JSON.stringify(settings));
        showOptions = true;
    }
    function closeOptions() {
        showOptions = false;
    }
    function saveOptions() {
        api.saveSettings(editingSettings);
        showOptions = false;
    }
    function openDataFolder() {
        api.openDataFolder();
    }
    function quit() {
        api.quit();
    }

    $: pinkHasMore = computed?.outOfBalanceSign >= 0;
    $: withinRange = computed?.withinRange;

    const crayon = {
        bg: "#fff8e7",
        card: "#fff1cf",
        stroke: "#2e2a24",
        pink: "#e91e63",
        green: "#2e7d32",
        gray: "#9e9e9e",
        accent: "#ffb74d",
    };
</script>

<svelte:window
    on:keydown={(e) => {
        if (e.key.toLowerCase() === "o") openOptions();
    }}
/>

<div
    class="root"
    style="--bg:{crayon.bg}; --card:{crayon.card}; --stroke:{crayon.stroke}; --accent:{crayon.accent}"
>
    <div class="row">
        <div class="title">Balance</div>
        <div class="btn" title="Quit" on:click={quit}>❌</div>
        <div class="btn" title="Options (o)" on:click={openOptions}>⚙️</div>
    </div>

    {#if settings && state}
        <div class="balance">
            <div
                class="pill"
                style="color: {withinRange
                    ? crayon.gray
                    : pinkHasMore
                      ? settings.missions[0].color
                      : settings.missions[1].color}"
            >
                <strong>{computed.outOfBalanceHours}</strong> hours out of balance
            </div>
        </div>

        <div class="balance">
            <div
                class="pill"
                style="color: {settings.missions[state.currentMissionIndex].color}"
            >
                Today: <strong>{computed.todayMinutes || 0}</strong> minutes
            </div>
        </div>

        <div class="tabs">
            {#each settings.missions as m, i}
                <div
                    class="tab {state.currentMissionIndex === i
                        ? 'active'
                        : ''}"
                    style="color:{m.color}"
                    on:click={() => switchMission(i)}
                >
                    {m.name}
                </div>
            {/each}
        </div>

        <div
            class="timer"
            style="color:{settings.missions[state.currentMissionIndex].color}"
        >
            {String(
                Math.floor((state.timer?.remainingSeconds || 0) / 60),
            ).padStart(2, "0")}:{String(
                (state.timer?.remainingSeconds || 0) % 60,
            ).padStart(2, "0")}
        </div>

        {#if hasEnded}
            <div class="balance" style="color:{crayon.accent}">Time's up</div>
        {/if}

        <div class="controls">
            {#if !state.timer?.running}
                <div
                    class="btn"
                    on:click={startWork}
                    style="background:#ffd2e1"
                >
                    Start 🍅
                </div>
                <div
                    class="btn"
                    on:click={startBreak}
                    style="background:#d9ffd6"
                >
                    Break 🌿
                </div>
            {:else}
                <div class="btn" on:click={stop}>Stop ⏹️</div>
            {/if}

            <div
                class="btn"
                on:click={(e) => {
                    if (e.shiftKey) extendBy(20);
                    else if (e.metaKey || e.ctrlKey) extendBy(5 * 60);
                    else extendBy(60);
                }}
            >
                + ⏱️
            </div>
            <div
                class="btn"
                on:click={(e) => {
                    if (e.shiftKey) extendBy(-20);
                    else if (e.metaKey || e.ctrlKey) extendBy(-5 * 60);
                    else extendBy(-60);
                }}
            >
                - ⏱️
            </div>
        </div>
    {/if}

    {#if showOptions}
        <div class="options">
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
                    <label>Acceptable balance range (hours)</label>
                    <input
                        type="number"
                        min="0"
                        bind:value={editingSettings.acceptableHourRange}
                    />
                </div>
                <div class="field">
                    <label>Work length (minutes)</label>
                    <input
                        type="number"
                        min="1"
                        bind:value={editingSettings.durations.workMinutes}
                    />
                </div>
                <div class="field">
                    <label>Break length (minutes)</label>
                    <input
                        type="number"
                        min="1"
                        bind:value={editingSettings.durations.breakMinutes}
                    />
                </div>
                <div class="field">
                    <label>Data directory</label>
                    <input
                        bind:value={editingSettings.dataDir}
                        placeholder="Default app data directory"
                    />
                </div>
                <div class="controls">
                    <div
                        class="btn"
                        role="button"
                        on:click={openDataFolder}
                        style="background:#e1f5fe"
                        title="Open data folder"
                    >
                        📁 Open Data Folder
                    </div>
                    <div
                        class="btn"
                        on:click={saveOptions}
                        style="background:#d6ffd9"
                    >
                        Save
                    </div>
                    <div
                        class="btn"
                        on:click={closeOptions}
                        style="background:#ffd2d2"
                    >
                        Cancel
                    </div>
                </div>
            </div>
        </div>
    {/if}
</div>

<style>
    :global(body) {
        margin: 0;
        background: transparent;
    }
    .root {
        width: 360px;
        height: 500px;
        padding: 14px;
        background: var(--bg);
        border: 3px solid var(--stroke);
        border-radius: 18px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.2);
        font-family:
            ui-rounded,
            system-ui,
            -apple-system,
            Segoe UI,
            Roboto,
            Cantarell,
            Noto Sans,
            sans-serif;
        color: #2e2a24;
    }
    .title {
        font-weight: 800;
        font-size: 22px;
        margin-bottom: 10px;
    }
    .balance {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        margin: 8px 0 14px;
    }
    .pill {
        padding: 10px 14px;
        border: 3px dashed var(--stroke);
        border-radius: 999px;
        background: var(--card);
    }
    .pill strong {
        font-size: 18px;
    }
    .controls {
        display: flex;
        gap: 8px;
        justify-content: center;
        margin-top: 10px;
        flex-wrap: wrap;
    }
    .btn {
        padding: 10px 12px;
        border: 3px solid var(--stroke);
        border-radius: 12px;
        background: var(--card);
        cursor: pointer;
        user-select: none;
        transition: transform 0.03s ease-in-out;
    }
    .btn:active {
        transform: translateY(1px);
    }
    .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        margin: 10px 0;
    }
    .timer {
        font-size: 48px;
        font-weight: 900;
        text-align: center;
        letter-spacing: 2px;
        text-shadow: 1px 1px #ffffff;
    }
    .tabs {
        display: flex;
        gap: 8px;
        justify-content: center;
        margin: 8px 0;
    }
    .tab {
        padding: 8px 12px;
        border: 3px solid var(--stroke);
        border-radius: 999px;
        background: var(--card);
        cursor: pointer;
    }
    .tab.active {
        outline: 4px solid var(--accent);
    }
    .options {
        position: absolute;
        inset: 0;
        background: rgba(255, 248, 231, 0.9);
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .sheet {
        width: 320px;
        background: var(--card);
        border: 3px solid var(--stroke);
        border-radius: 16px;
        padding: 12px;
    }
    .field {
        margin: 8px 0;
    }
    input,
    select {
        width: 100%;
        padding: 8px 10px;
        border: 3px solid var(--stroke);
        border-radius: 10px;
        background: #fff;
    }
</style>
