<script lang="ts">
  import { onDestroy } from 'svelte'
  import { formatClipDuration } from './voiceClips'
  import { canChooseVoiceMic, finishVoiceRecording, startVoiceRecording, switchVoiceMic, voiceMic, voiceMicSwitching, voiceRecording } from './voiceRecorder'

  // Record, then stop; a mic choice shows while recording on Android.
  export let onStart: () => void = () => {}
  export let onStop: () => void = () => { void finishVoiceRecording() }
  export let disabled = false

  let now = Date.now()
  let clock: number | null = null

  $: recording = $voiceRecording.state === 'recording' ? $voiceRecording : null
  $: syncClock(recording !== null)

  function syncClock(running: boolean) {
    if (running && clock === null) clock = window.setInterval(() => { now = Date.now() }, 250)
    else if (!running && clock !== null) {
      window.clearInterval(clock)
      clock = null
    }
    now = Date.now()
  }

  function start() {
    onStart()
    void startVoiceRecording()
  }

  onDestroy(() => {
    if (clock !== null) window.clearInterval(clock)
  })
</script>

<div class="voice-record-controls">
  {#if recording}
    <span class="voice-recording-dot" style:--level={recording.level} aria-hidden="true"></span>
    <span class="voice-recording-time">{formatClipDuration(now - recording.startedAt)}</span>
    {#if canChooseVoiceMic()}
      <div class="voice-mic-choice">
        <button class="ghost" type="button" aria-label="Headset microphone" title="Headset" aria-pressed={$voiceMic === 'headset'} disabled={$voiceMicSwitching} on:click={() => { void switchVoiceMic('headset') }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v6H4zM17 14h3v6h-3z" /></svg>
        </button>
        <button class="ghost" type="button" aria-label="Phone microphone" title="Phone" aria-pressed={$voiceMic === 'phone'} disabled={$voiceMicSwitching} on:click={() => { void switchVoiceMic('phone') }}>
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3h8a1 1 0 0 1 1 1v16a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM11 18h2" /></svg>
        </button>
      </div>
    {/if}
    <button class="voice-record-button recording" type="button" aria-label="Stop recording" title="Stop" {disabled} on:click={onStop}>■</button>
  {:else}
    <button
      class="voice-record-button"
      type="button"
      aria-label="Record an idea"
      title="Record"
      disabled={disabled || $voiceRecording.state !== 'idle'}
      on:click={start}
    >●</button>
  {/if}
</div>

<style>
  .voice-record-controls {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .voice-mic-choice { display: inline-flex; gap: 2px; }
  .voice-mic-choice button { display: inline-grid; place-items: center; width: 32px; height: 32px; padding: 0; color: var(--muted); }
  .voice-mic-choice button[aria-pressed='true'] { color: var(--ink); background: color-mix(in srgb, var(--ink) 12%, transparent); }
  .voice-mic-choice svg { width: 16px; height: 16px; fill: none; stroke: currentColor; stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
  .voice-record-button.voice-record-button {
    width: 32px;
    height: 32px;
    padding: 0;
    border-radius: 50%;
    color: var(--danger);
    font-size: 14px;
    line-height: 1;
  }
  .voice-record-button.recording { color: var(--ink); font-size: 11px; }
  .voice-recording-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--danger);
    box-shadow: 0 0 0 calc(var(--level, 0) * 7px) color-mix(in srgb, var(--danger) 30%, transparent);
    transition: box-shadow 80ms linear;
  }
  .voice-recording-time { color: var(--muted); font-size: 13px; font-variant-numeric: tabular-nums; }
</style>
