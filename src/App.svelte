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
    function togglePlayPause() {
        const running = !!state?.timer?.running;
        const remaining = state?.timer?.remainingSeconds || 0;
        if (running) {
            api.pause();
        } else if (remaining > 0) {
            api.resume();
        } else {
            // No timer yet; start based on current selection (default to work when unknown)
            if (state?.timer?.isBreak) startBreak();
            else startWork();
        }
        hasEnded = false;
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
        const target = e.target;
        const tag = (target?.tagName || "").toLowerCase();
        const isEditable =
            tag === "input" ||
            tag === "textarea" ||
            tag === "select" ||
            target?.isContentEditable;
        if (isEditable || showOptions || e.metaKey || e.ctrlKey || e.altKey)
            return;
        if (e.key && e.key.toLowerCase() === "o" && !e.repeat) openOptions();
    }}
/>

<div
    class="root"
    style="--bg:{crayon.bg}; --card:{crayon.card}; --stroke:{crayon.stroke}; --accent:{crayon.accent}"
>
    <div class="row">
        <div class="title">Balance</div>
        <div class="btn" title="Options (o)" on:click={openOptions}>⚙️</div>
    </div>

    {#if settings && state}
        <!-- Only show balance for tracked missions -->
        {#if !settings.missions[state.currentMissionIndex]?.untracked}
            <div class="balance">
                <div
                    class="pill"
                    style="color: {withinRange
                        ? crayon.gray
                        : pinkHasMore
                          ? settings.missions[0].color
                          : settings.missions[1].color}"
                >
                    <strong>{computed.outOfBalanceHours}</strong> hours out of
                    balance: you need to work on
                    <span
                        style="color: {pinkHasMore
                            ? settings.missions[1].color
                            : settings.missions[0].color}"
                        >{pinkHasMore
                            ? settings.missions[1].name
                            : settings.missions[0].name}</span
                    >
                </div>
            </div>
        {/if}

        <div class="balance">
            <div
                class="pill"
                style="color: {settings.missions[state.currentMissionIndex]
                    .color}"
            >
                Lifetime: <strong
                    >{Math.floor(
                        (computed.lifetimeMinutes || 0) / 60,
                    )}h{(computed.lifetimeMinutes || 0) % 60}m</strong
                >
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
            style="color:{state.timer?.isBreak
                ? crayon.gray
                : settings.missions[state.currentMissionIndex].color}"
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

        <!-- Top row: Pomodoro | Break | - | + -->
        <div class="controls top-controls">
            <div
                class="btn seg {state.timer?.isBreak ? '' : 'selected'}"
                on:click={startWork}
                style="background:#ffd2e1"
                title="Start pomodoro"
            >
                🍅 Pomodoro
            </div>
            <div
                class="btn seg {state.timer?.isBreak ? 'selected' : ''}"
                on:click={startBreak}
                style="background:#d9ffd6"
                title="Start break"
            >
                🌿 Break
            </div>
            <div
                class="btn"
                on:click={(e) => {
                    if (e.shiftKey) extendBy(-20);
                    else if (e.metaKey || e.ctrlKey) extendBy(-5 * 60);
                    else extendBy(-60);
                }}
                title="-1m (shift: -20s, ctrl/cmd: -5m)"
            >
                -
            </div>
            <div
                class="btn"
                on:click={(e) => {
                    if (e.shiftKey) extendBy(20);
                    else if (e.metaKey || e.ctrlKey) extendBy(5 * 60);
                    else extendBy(60);
                }}
                title="+1m (shift: +20s, ctrl/cmd: +5m)"
            >
                +
            </div>
        </div>

        <!-- Bottom row: Play/Pause -->
        <div class="controls bottom-controls">
            <div class="btn play" on:click={togglePlayPause} title="Play/Pause">
                {#if state.timer?.running}
                    ⏸️
                {:else}
                    ▶️
                {/if}
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
                    <div class="btn" on:click={quit} style="background:#ffcccb">
                        Quit App
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
        background: var(--bg, #fff8e7); /* Fallback background */
        border: 3px solid var(--stroke, #2e2a24); /* Fallback border */
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
    .top-controls {
        margin-top: 12px;
    }
    .bottom-controls {
        margin-top: 6px;
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
    .btn.selected {
        outline: 4px solid var(--accent);
    }
    .btn.seg {
        border-radius: 999px;
    }
    .btn.play {
        min-width: 64px;
        text-align: center;
        font-size: 20px;
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
        width: calc(100% - 24px);
        max-width: 320px;
        background: var(--card);
        border: 3px solid var(--stroke);
        border-radius: 16px;
        padding: 12px;
        box-sizing: border-box;
    }
    .field {
        margin: 8px 0;
    }
    .field-row {
        display: flex;
        gap: 8px;
        margin: 8px 0;
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
    }
</style>
