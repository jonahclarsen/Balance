<script>
    import { onMount } from "svelte";
    import Options from "./Options.svelte";
    import TimerDisplay from "./components/TimerDisplay.svelte";
    import TimerControls from "./components/TimerControls.svelte";
    import { THEME_PALETTES } from "./themes.js";
    import "./button.css";

    const api = window.cactus;

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
        // Use theme from settings, default to neutral if not set
        const themeName = settings?.theme || "neutral";
        const theme = THEME_PALETTES[themeName] || THEME_PALETTES.neutral;

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
    {#if settings && state}
        <div class="main-content">
            <TimerDisplay {state} {crayon} />
            <TimerControls {state} {api} bind:hasEnded />
            <div class="bottom-controls">
                <div
                    class="link"
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
                <div
                    class="link"
                    on:click={openOptions}
                    on:keydown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            openOptions();
                        }
                    }}
                    role="button"
                    tabindex="0"
                    title="Options (o)"
                >
                    Options
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
        width: 310px;
        height: 340px;
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

    .link {
        color: var(--accent);
        text-decoration: underline;
        cursor: pointer;
        font-size: 13px;
        user-select: none;
        margin-left: 5px;
        margin-right: 5px;
    }

    .link:hover {
        opacity: 0.8;
    }

    .link:focus {
        outline: 2px solid var(--accent);
        outline-offset: 2px;
    }
</style>
