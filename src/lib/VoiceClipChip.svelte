<script lang="ts">
  import { formatClipDuration } from './voiceClips'
  import type { VoiceClip } from './types'

  // A small waveform and duration that opens the clip's Voice idea dialog.
  export let clip: VoiceClip
  export let onOpen: () => void

  const BARS = 48
  $: count = Math.min(BARS, clip.peaks.length)
  $: bars = Array.from({ length: count }, (_, index) => clip.peaks[Math.floor((index * clip.peaks.length) / count)] ?? 0)
</script>

<button
  type="button"
  class="voice-clip-chip"
  data-voice-clip={clip.id}
  aria-label={`Voice idea, ${formatClipDuration(clip.durationMs)}`}
  on:click={onOpen}
>
  <svg viewBox={`0 0 ${count} 16`} preserveAspectRatio="none" aria-hidden="true">
    {#each bars as peak, index}
      <rect x={index + 0.15} width="0.7" y={8 - Math.max(0.6, (peak / 255) * 8)} height={Math.max(1.2, (peak / 255) * 16)} />
    {/each}
  </svg>
  <span>{formatClipDuration(clip.durationMs)}</span>
</button>

<style>
  .voice-clip-chip {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    flex: none;
    padding: 2px 8px;
    border-radius: 999px;
    color: var(--accent);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .voice-clip-chip svg { width: 56px; height: 14px; fill: currentColor; }
  .voice-clip-chip span { color: var(--muted); }
</style>
