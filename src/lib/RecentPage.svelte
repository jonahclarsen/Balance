<script lang="ts">
  export let retained: boolean
  export let active: boolean
</script>

{#if retained}
  <div class="recent-page" hidden={!active} inert={!active}>
    <slot />
  </div>
{/if}

<style>
  .recent-page { display: contents; }
  .recent-page[hidden] { display: none; }
</style>
