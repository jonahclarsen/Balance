<script>
    export let state;
    export let api;
    export let hasEnded;

    function startWork() {
        hasEnded = false;
        api.startWork();
    }

    function startBreak() {
        hasEnded = false;
        api.startBreak();
    }

    function extendBy(seconds) {
        api.extend(seconds);
    }

    export function togglePlayPause() {
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
</script>

<div class="time-controls">
    <!-- Mission-control row: Pomodoro | Break -->
    <div class="controls mission-control">
        <button
            class="btn seg {state.timer?.isBreak ? '' : 'selected'}"
            on:click={startWork}
            style="background:var(--card)"
            title="Start pomodoro"
        >
            🍅 Start Pomodoro
        </button>
        <button
            class="btn seg {state.timer?.isBreak ? 'selected' : ''}"
            on:click={startBreak}
            style="background:var(--card)"
            title="Start break"
        >
            🌿 Start Break
        </button>
    </div>

    <!-- Time-control row: +1m, -1m -->
    <div class="controls time-control">
        <button
            class="btn time-control-btn"
            on:click={(e) => {
                if (e.metaKey || e.ctrlKey) extendBy(5 * 60);
                else extendBy(60);
            }}
            title="Increase time by 1 minute"
        >
            +
        </button>
        <button
            class="btn time-control-btn"
            on:click={(e) => {
                if (e.metaKey || e.ctrlKey) extendBy(-5 * 60);
                else extendBy(-60);
            }}
            title="Decrease time by 1 minute"
        >
            -
        </button>
    </div>
    <div class="keyboard-instructions">
        <p>
            Hold {navigator.platform.includes("Mac") ? "⌘" : "ctrl"}
            for +-5m
        </p>
    </div>
</div>

<style>
    .time-controls {
        display: flex;
        flex-direction: column;
        justify-content: center;
        align-items: center;
        padding: 0px;
        margin-top: 10px;
        margin-bottom: 20px;
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
        margin-bottom: 8px;
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
    .keyboard-instructions {
        font-size: 11px;
        line-height: 1.2;
        color: var(--gray);
        margin-left: 12px;
        text-align: left;
    }
</style>
