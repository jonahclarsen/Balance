<script lang="ts">
  import { automaticSyncStatus } from './syncScheduler'

  $: visible =
    $automaticSyncStatus.configured !== false &&
    ($automaticSyncStatus.running ||
      !$automaticSyncStatus.initialSyncComplete ||
      Boolean($automaticSyncStatus.lastError))
  $: label = $automaticSyncStatus.offline
    ? 'Offline'
    : $automaticSyncStatus.lastError
      ? 'Retrying'
      : 'Syncing'
  $: state = $automaticSyncStatus.offline
    ? 'offline'
    : $automaticSyncStatus.lastError
      ? 'retrying'
      : 'syncing'
</script>

{#if visible}
  <span
    class="sync-status-indicator"
    class:offline={state === 'offline'}
    class:retrying={state === 'retrying'}
    role="status"
    aria-label={`Sync status: ${label}`}
    title={$automaticSyncStatus.lastError || label}
  >
    <span class="sync-status-dot" aria-hidden="true"></span>
    <span>{label}</span>
  </span>
{/if}
