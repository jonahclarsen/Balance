<script lang="ts" generics="RangeDays extends number">
  export let ranges: readonly RangeDays[]
  export let rangeDays: RangeDays
</script>

<div class="range-switcher" role="group" aria-label="Statistics date range">
  {#each ranges as days}
    <button type="button" class:active={rangeDays === days} aria-pressed={rangeDays === days} on:click={() => (rangeDays = days)}>{days} days</button>
  {/each}
</div>

<style>
  .range-switcher {
    display: inline-flex;
    flex: 0 0 auto;
    padding: 3px;
    border: 1px solid var(--line);
    border-radius: 8px;
    background: var(--paper);
  }

  .range-switcher button {
    padding: 5px 9px;
    border: 0;
    background: transparent;
    color: var(--muted);
    font-size: 12px;
  }

  .range-switcher button.active {
    background: var(--active-nav);
    color: var(--ink);
  }

  @media (max-width: 420px) {
    .range-switcher {
      width: 100%;
    }

    .range-switcher button {
      flex: 1 1 0;
    }
  }
</style>
