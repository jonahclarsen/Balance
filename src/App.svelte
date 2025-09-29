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

    function openOptions() {
        editingSettings = JSON.parse(JSON.stringify(settings));
        showOptions = true;
    }

    $: pinkHasMore = computed?.outOfBalanceSign >= 0;
    $: withinRange = computed?.withinRange;

    const crayon = {
        bg: "#FFE2F5",
        card: "#FDB3DB",
        stroke: "#BF6091",
        accent: "#E47ED1", // selected
        mission1: "#e91e63",
        mission2: "#108AB0",
        breakColor: "#DDDDDD",
        gray: "#8C8C8C",
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
        // Block browser zoom shortcuts globally
        if (
            (e.metaKey || e.ctrlKey) &&
            ["+", "=", "-", "_", "0"].includes(e.key)
        ) {
            e.preventDefault();
            return;
        }
        if (isEditable || showOptions || e.altKey) return;
        if (e.key && e.key.toLowerCase() === "o" && !e.repeat) openOptions();
    }}
/>

<div
    class="root"
    style="--bg:{crayon.bg}; --card:{crayon.card}; --stroke:{crayon.stroke}; --accent:{crayon.accent}"
>
    <div class="row">
        <div class="title">
            Balance — Time for
            <span
                style="color:{state && state.timer?.isBreak
                    ? crayon.gray
                    : state && state.currentMissionIndex === 0
                      ? crayon.mission1
                      : state && state.currentMissionIndex === 2
                        ? crayon.gray
                        : crayon.mission2}"
            >
                {#if settings && state}
                    {#if state.timer?.isBreak}
                        Break
                    {:else}
                        {settings.missions[state.currentMissionIndex].name}
                    {/if}
                {:else}[undefined]{/if}
            </span>
        </div>
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
                    : state.currentMissionIndex === 0
                      ? crayon.mission1
                      : state.currentMissionIndex === 2
                        ? crayon.gray
                        : crayon.mission2}"
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
                    style="background:{crayon.breakColor}"
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
            <div class="tabs">
                {#each settings.missions as m, i}
                    <button
                        class="tab {state.currentMissionIndex === i
                            ? 'active'
                            : ''}"
                        style="color:{i === 0
                            ? crayon.mission1
                            : i === 2
                              ? crayon.gray
                              : crayon.mission2}"
                        on:click={() => switchMission(i)}
                    >
                        {m.name}
                    </button>
                {/each}
            </div>

            <div class="balance">
                <div
                    class="pill"
                    style="color: {state.currentMissionIndex === 0
                        ? crayon.mission1
                        : state.currentMissionIndex === 2
                          ? crayon.gray
                          : crayon.mission2}"
                >
                    Lifetime: <strong
                        >{Math.floor(
                            (computed.lifetimeMinutes || 0) / 60,
                        )}h{(computed.lifetimeMinutes || 0) % 60}m</strong
                    >
                </div>
            </div>

            <div class="balance">
                <div
                    class="pill"
                    style="width: {state.currentMissionIndex === 3 ? 60 : 70}%;
                        color: {withinRange
                        ? crayon.gray
                        : pinkHasMore
                          ? crayon.mission1
                          : crayon.mission2}"
                >
                    <strong>{computed.outOfBalanceHours}</strong> hours out of
                    balance; recover with
                    <span
                        style="color: {pinkHasMore
                            ? crayon.mission2
                            : crayon.mission1}"
                        >{pinkHasMore
                            ? settings.missions[1].name
                            : settings.missions[0].name}</span
                    >
                </div>
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
        height: 540px;
        /* overflow: hidden; */
        padding: 14px;
        background: var(--bg);
        /* Fallback background */
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
        margin: 8px 0 8px;
    }
    .pill {
        padding: 10px 14px;
        border: 3px dashed var(--stroke);
        border-radius: 999px;
        font-size: 14px;
        background: var(--card);
    }
    .pill strong {
        font-size: 16px;
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
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        padding: 20px 0; /* Reduce the effective content area to half */
    }
    .mission-select {
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
        font-size: 15px;
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
