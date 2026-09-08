<script lang="ts">
  import { automaticSyncStatus } from './syncScheduler'

  export let onOpenError: () => void

  $: visible =
    $automaticSyncStatus.configured !== false &&
    ($automaticSyncStatus.offline ||
      Boolean($automaticSyncStatus.lastError) ||
      ($automaticSyncStatus.running &&
        ($automaticSyncStatus.showActivity || !$automaticSyncStatus.initialSyncComplete)))
  $: label = $automaticSyncStatus.offline
    ? 'Offline'
    : $automaticSyncStatus.lastError
      ? 'Error'
      : 'Syncing'
  $: state = $automaticSyncStatus.offline
    ? 'offline'
    : $automaticSyncStatus.lastError
      ? 'error'
      : 'syncing'
</script>

{#if visible}
  <span
    class="sync-status-indicator"
    class:offline={state === 'offline'}
    class:error={state === 'error'}
    role="status"
    aria-label={`Sync status: ${label}`}
    title={$automaticSyncStatus.lastError || label}
  >
    {#if state === 'error'}
      <button type="button" class="sync-error-button" aria-label="Sync error: open settings" on:click={onOpenError}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9" /><path d="M12 7v6m0 3v1" /></svg>
        <span>{label}</span>
      </button>
    {:else}
      <span class="sync-status-dot" aria-hidden="true"></span>
      <span>{label}</span>
    {/if}
  </span>
{/if}
