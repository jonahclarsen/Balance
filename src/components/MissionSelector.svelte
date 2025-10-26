<script>
    import { THEME_PALETTES } from "../themes.js";

    export let settings;
    export let state;
    export let computed;
    export let crayon;
    export let api;

    function switchMission(i) {
        api.switchMission(i);
    }

    $: visibleMissions = settings.missions.filter((m) => !m.deleted);
    $: balanceStatus = computed?.balanceStatus;
    $: needsMoreMission = balanceStatus
        ? settings.missions[balanceStatus.needsMoreMissionIndex]
        : null;
</script>

<div class="mission-select">
    <div class="tabs">
        {#each visibleMissions as m, visIdx}
            {@const actualIdx = settings.missions.indexOf(m)}
            <button
                class="tab {state.currentMissionIndex === actualIdx
                    ? 'active'
                    : ''}"
                style="color:{THEME_PALETTES[m.theme].primary}"
                on:click={() => switchMission(actualIdx)}
            >
                {m.name}
            </button>
        {/each}
    </div>

    <div class="balance">
        <div
            class="pill"
            style="color: {THEME_PALETTES[
                settings.missions[state.currentMissionIndex].theme
            ].primary}"
        >
            Lifetime: <strong
                >{Math.floor(
                    (computed.lifetimeMinutes || 0) / 60,
                )}h{(computed.lifetimeMinutes || 0) % 60}m</strong
            >
        </div>
    </div>

    <div class="balance">
        {#if balanceStatus}
            <div
                class="pill"
                style="width: 70%;
                    color: {balanceStatus.isBalanced
                    ? crayon.gray
                    : needsMoreMission
                      ? THEME_PALETTES[needsMoreMission.theme].primary
                      : crayon.gray}"
            >
                {#if balanceStatus.isBalanced}
                    <strong>✓ In balance.</strong>
                {:else}
                    <strong>{balanceStatus.deficitHours}h</strong> out of
                    balance; recover with
                    <span
                        style="color: {needsMoreMission
                            ? THEME_PALETTES[needsMoreMission.theme].primary
                            : crayon.gray}"
                        >{needsMoreMission ? needsMoreMission.name : "?"}</span
                    >
                {/if}
            </div>
        {/if}
    </div>
</div>

<style>
    .mission-select {
        background: var(--card);
        padding: 10px;
        border-radius: 50px;
        width: 75%;
        margin: 10px auto 5px auto; /* top right bottom left */
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
    .balance {
        display: flex;
        align-items: center;
        text-align: center;
        justify-content: center;
        gap: 10px;
        margin: 8px 0 8px;
    }
    .pill {
        padding: 0px 14px;
        border: none;
        border-radius: 999px;
        font-size: 14px;
        background: var(--card);
    }
    .pill strong {
        font-size: 16px;
    }
</style>
