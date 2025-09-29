<script>
    import { onMount } from "svelte";
    import Options from "./Options.svelte";
    import "./button.css";

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

    function addTrackedMinutes(delta) {
        api.adjustMinutes(delta);
    }

    function openOptions() {
        editingSettings = JSON.parse(JSON.stringify(settings));
        showOptions = true;
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
        <button class="btn" title="Options (o)" on:click={openOptions}
            >⚙️</button
        >
    </div>

    {#if settings && state}
        <div class="time-controls">
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

            <!-- Mission-control row: Pomodoro | Break -->
            <div class="controls mission-control">
                <button
                    class="btn seg {state.timer?.isBreak ? '' : 'selected'}"
                    on:click={startWork}
                    style="background:#ffd2e1"
                    title="Start pomodoro"
                >
                    🍅 Start Pomodoro
                </button>
                <button
                    class="btn seg {state.timer?.isBreak ? 'selected' : ''}"
                    on:click={startBreak}
                    style="background:#d9ffd6"
                    title="Start break"
                >
                    🌿 Start Break
                </button>
            </div>

            <!-- Time-control row: +1m, -1m -->
            <div class="controls time-control">
                <button
                    class="btn play"
                    on:click={togglePlayPause}
                    title="Play/Pause"
                >
                    {#if state.timer?.running}
                        ⏸️
                    {:else}
                        ▶️
                    {/if}
                </button>
                <button
                    class="btn time-control-btn"
                    on:click={(e) => {
                        if (e.shiftKey) extendBy(20);
                        else if (e.metaKey || e.ctrlKey) extendBy(5 * 60);
                        else extendBy(60);
                    }}
                    title="Increase time by 1 minute"
                >
                    +
                </button>
                <button
                    class="btn time-control-btn"
                    on:click={(e) => {
                        if (e.shiftKey) extendBy(-20);
                        else if (e.metaKey || e.ctrlKey) extendBy(-5 * 60);
                        else extendBy(-60);
                    }}
                    title="Decrease time by 1 minute"
                >
                    -
                </button>
                <button
                    class="btn"
                    title="Add 1 tracked minute (manual)"
                    on:click={() => addTrackedMinutes(1)}
                    style="background:#e1f5fe"
                >
                    +1m ✅
                </button>
                <button
                    class="btn"
                    title="Remove 1 tracked minute (manual)"
                    on:click={() => addTrackedMinutes(-1)}
                    style="background:#ffe1e1"
                >
                    -1m ✅
                </button>
            </div>
            <div class="keyboard-instructions">
                <p>
                    Hold {navigator.platform.includes("Mac") ? "⌘" : "ctrl"} for
                    +-5m
                </p>
                <p>Hold shift for +-20s</p>
            </div>
        </div>

        <div class="mission-select">
            <!-- Only show balance for tracked missions -->
            {#if !settings.missions[state.currentMissionIndex]?.untracked}
                <div class="balance">
                    <div
                        class="pill balance-pill"
                        style="color: {withinRange
                            ? crayon.gray
                            : pinkHasMore
                              ? settings.missions[0].color
                              : settings.missions[1].color}"
                    >
                        <strong>{computed.outOfBalanceHours}</strong> hours out
                        of balance: you need to work on
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
                    <button
                        class="tab {state.currentMissionIndex === i
                            ? 'active'
                            : ''}"
                        style="color:{m.color}"
                        on:click={() => switchMission(i)}
                    >
                        {m.name}
                    </button>
                {/each}
            </div>
        </div>
    {/if}

    {#if showOptions}
        <Options
            {editingSettings}
            {api}
            on:close={() => (showOptions = false)}
        />
    {/if}
</div>

<style>
    :global(body) {
        margin: 0;
        background: transparent;
    }

    .root {
        width: 360px;
        height: 480px;
        max-height: 480px;
        /* overflow: hidden; */
        padding: 14px;
        background: var(--bg, #fff8e7);
        /* Fallback background */
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
        display: flex;
        flex-direction: column;
    }
    .title {
        font-weight: 600;
        font-size: 22px;
        margin-bottom: 10px;
        margin-top: 0px;
        margin-left: 10px;
    }
    .balance {
        display: flex;
        align-items: center;
        text-align: center;
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
    .balance-pill {
        width: 60%;
    }
    .pill strong {
        font-size: 18px;
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
    .mission-control {
        margin-top: 12px;
        margin-bottom: 15px;
    }
    .time-control {
        margin-top: 6px;
        margin-bottom: 2px;
    }
    .time-control-btn {
        width: 50px;
        height: 50px;
        font-size: 24px;
    }
    .btn.selected {
        outline: 4px solid var(--accent);
    }

    .btn.seg {
        border-radius: 999px;
    }
    .btn.play {
        width: 50px;
        height: 50px;
        text-align: center;
        font-size: 19px;
    }
    .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .time-controls {
        flex: 7; /* 70% of available space */
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        padding: 20px 0; /* Reduce the effective content area to half */
    }
    .mission-select {
        flex: 3; /* 30% of available space */
        background: var(--card);
        padding: 10px;
        border-radius: 50px;
        width: 75%;
        margin: 0 auto;
    }
    .timer {
        font-size: 60px;
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
    .keyboard-instructions {
        font-size: 11px;
        line-height: 1px;
        padding-bottom: 3px;
        color: var(--gray);
        text-align: center;
    }
</style>
