<script lang="ts">
  export let title: string
  export let description = ''
</script>

<section class="chart-card">
  <div class="section-heading">
    <div>
      <h4>{title}</h4>
      {#if description}<p>{description}</p>{/if}
    </div>
    <slot name="aside" />
  </div>
  <slot />
</section>

<style>
  .chart-card {
    min-width: 0;
    padding: 13px 14px;
    border: 1px solid var(--line);
    border-radius: 10px;
    background: var(--paper);
  }

  .section-heading,
  .section-heading > div {
    min-width: 0;
  }

  .section-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 14px;
  }

  .section-heading h4 {
    margin: 0 0 2px;
    font-size: 14px;
  }

  .section-heading p {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }

  .section-heading > :global(strong) {
    flex: 0 0 auto;
    font-size: 13px;
  }
</style>
