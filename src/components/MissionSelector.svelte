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

    $: mission0HasMore = computed?.outOfBalanceSign >= 0;
    $: withinRange = computed?.withinRange;
</script>

<div class="mission-select">
    <div class="tabs">
        {#each settings.missions as m, i}
            <button
                class="tab {state.currentMissionIndex === i ? 'active' : ''}"
                style="color:{THEME_PALETTES[m.theme].primary}"
                on:click={() => switchMission(i)}
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
        <div
            class="pill"
            style="width: {state.currentMissionIndex === 3 ? 60 : 70}%;
                color: {withinRange
                ? crayon.gray
                : mission0HasMore
                  ? THEME_PALETTES[settings.missions[0].theme].primary
                  : THEME_PALETTES[settings.missions[1].theme].primary}"
        >
            <strong>{computed.outOfBalanceHours}</strong> hours out of balance;
            recover with
            <span
                style="color: {mission0HasMore
                    ? THEME_PALETTES[settings.missions[1].theme].primary
                    : THEME_PALETTES[settings.missions[0].theme].primary}"
                >{mission0HasMore
                    ? settings.missions[1].name
                    : settings.missions[0].name}</span
            >
        </div>
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
