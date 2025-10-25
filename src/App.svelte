<script>
    import { onMount } from "svelte";
    import Options from "./Options.svelte";
    import TimerDisplay from "./components/TimerDisplay.svelte";
    import TimerControls from "./components/TimerControls.svelte";
    import MissionSelector from "./components/MissionSelector.svelte";
    import { THEME_PALETTES } from "./themes.js";
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

    function openOptions() {
        editingSettings = JSON.parse(JSON.stringify(settings));
        showOptions = true;
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
            if (state?.timer?.isBreak) api.startBreak();
            else api.startWork();
        }
        hasEnded = false;
    }

    function computeTheme(settings, state) {
        // If settings are not loaded yet, return neutral theme
        if (!settings?.missions) {
            return {
                ...THEME_PALETTES.neutral,
                gray: THEME_PALETTES.neutral.primary,
            };
        }

        const idx = state?.currentMissionIndex;
        const mission = settings.missions[idx];
        const theme = THEME_PALETTES[mission.theme];

        return {
            ...theme,
            gray: THEME_PALETTES.neutral.primary,
        };
    }

    $: crayon = computeTheme(settings, state);
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
    style="--bg:{crayon.bg}; --card:{crayon.card}; --stroke:{crayon.stroke}; --accent:{crayon.accent}; --gray:{crayon.gray}"
>
    <div class="row">
        <div class="title">
            Balance — Time for
            <span
                style="color:{state && state.timer?.isBreak
                    ? crayon.gray
                    : settings && state
                      ? THEME_PALETTES[
                            settings.missions[state.currentMissionIndex].theme
                        ].primary
                      : crayon.gray}"
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
        <div class="main-content">
            <TimerDisplay {state} {crayon} />
            <TimerControls {state} {api} bind:hasEnded />
            <MissionSelector {settings} {state} {computed} {crayon} {api} />
            <div class="bottom-controls">
                <div
                    class="play-pause-link"
                    on:click={togglePlayPause}
                    on:keydown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            togglePlayPause();
                        }
                    }}
                    role="button"
                    tabindex="0"
                >
                    {#if state.timer?.running}
                        Pause Timer
                    {:else if state.timer?.remainingSeconds === 0}
                        Start Timer
                    {:else}
                        Resume Timer
                    {/if}
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
        padding: 14px;
        background: var(--bg);
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
    .row {
        display: flex;
        align-items: center;
        justify-content: space-between;
    }
    .main-content {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
    }

    .bottom-controls {
        display: flex;
        justify-content: center;
        padding: -20px 0;
    }

    .play-pause-link {
        color: var(--accent);
        text-decoration: underline;
        cursor: pointer;
        font-size: 12px;
        user-select: none;
    }

    .play-pause-link:hover {
        opacity: 0.8;
    }

    .play-pause-link:focus {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
    }
</style>
