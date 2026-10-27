<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import OverlayModal from './OverlayModal.svelte'
  import VoiceWaveform from './VoiceWaveform.svelte'
  import { autoGrow } from './autoGrow'
  import { escapeHTML } from './planner'
  import { IDEA_GROUPS, IDEA_UNLOCK_MS } from './ideas'
  import { alignTranscript, formatClipDuration, timeRangeForSelection, tokenAtTime, type TimedToken } from './voiceClips'
  import { decodeClip } from './voiceRecorder'
  import { canTranscribe, transcriptionStatus } from './voiceTranscription'
  import type { IdeaGroupKind, IdeaItem, VoiceClip } from './types'

  // Reading a transcript beside its audio: selecting text moves the waveform to
  // where it was said, and a tap on the waveform selects the word spoken there.
  export let clip: VoiceClip
  export let idea: IdeaItem
  export let onEdit: (text: string, html: string) => void
  export let onMove: (kind: IdeaGroupKind) => void
  export let onTranscribe: () => void
  export let onClose: () => void

  const durationSeconds = clip.durationMs / 1000
  const targets = IDEA_GROUPS.filter((group) => group.kind !== 'proposition')
  const openedAt = Date.now()

  let text = idea.text
  let input: HTMLTextAreaElement
  let waveform: VoiceWaveform
  let playhead = 0
  let range: { start: number; end: number } | null = null
  let playing = false
  let audio: AudioBuffer | null = null
  let context: AudioContext | null = null
  let source: AudioBufferSourceNode | null = null
  let playStartedAt = 0
  let playFrom = 0
  let playUntil = 0
  let frame = 0
  let unlockTick = 0
  const unlockTimers = targets.map((target) => window.setTimeout(() => { unlockTick += 1 }, IDEA_UNLOCK_MS[target.kind]))

  // A transcript arriving while open replaces the still-empty draft.
  $: if (!text && idea.text) text = idea.text
  $: tokens = alignTranscript(text, clip.transcript?.words ?? [], durationSeconds)
  $: spoken = clip.transcript ? tokenAtTime(tokens, playhead) : null
  $: transcribing = $transcriptionStatus.state !== 'idle'

  function locked(kind: IdeaGroupKind, _tick: number) {
    return Date.now() < openedAt + IDEA_UNLOCK_MS[kind]
  }

  function edit() {
    const trimmed = text.trim()
    onEdit(trimmed, escapeHTML(trimmed))
  }

  async function ensureAudio() {
    audio ??= await decodeClip(clip.dataURL)
    context ??= new AudioContext()
    if (context.state === 'suspended') await context.resume()
  }

  function stop() {
    if (source) {
      source.onended = null
      source.stop()
      source.disconnect()
      source = null
    }
    playing = false
    if (frame) cancelAnimationFrame(frame)
    frame = 0
  }

  async function play(from: number, until = durationSeconds) {
    stop()
    await ensureAudio()
    if (!audio || !context) return
    const start = from >= until - 0.05 ? 0 : from
    source = context.createBufferSource()
    source.buffer = audio
    source.connect(context.destination)
    source.onended = () => { stop() }
    source.start(0, start, until - start)
    playStartedAt = context.currentTime
    playFrom = start
    playUntil = until
    playing = true
    const follow = () => {
      if (!playing || !context) return
      playhead = Math.min(playUntil, playFrom + context.currentTime - playStartedAt)
      waveform?.reveal(playhead, false)
      frame = requestAnimationFrame(follow)
    }
    follow()
  }

  function togglePlay() {
    if (playing) {
      stop()
      return
    }
    void (range ? play(range.start, range.end) : play(playhead))
  }

  // The waveform follows the text selection as you read.
  function syncFromSelection() {
    if (!input || !clip.transcript) return
    const selected = timeRangeForSelection(tokens, input.selectionStart, input.selectionEnd)
    if (!selected) return
    range = input.selectionStart === input.selectionEnd ? null : selected
    if (!playing) playhead = selected.start
    waveform?.reveal(selected.start)
  }

  function handleSelectionChange() {
    if (document.activeElement === input) syncFromSelection()
  }

  async function selectToken(token: TimedToken | null, end: TimedToken | null = token, focus = true) {
    if (!token || !end || !input) return
    if (focus) input.focus({ preventScroll: true })
    input.setSelectionRange(token.from, end.to)
    await tick()
    document.querySelector('.voice-idea-mirror mark')?.scrollIntoView({ block: 'nearest' })
  }

  function seek(seconds: number) {
    playhead = seconds
    range = null
    if (playing) void play(seconds)
    if (clip.transcript) void selectToken(tokenAtTime(tokens, seconds), undefined, !matchMedia('(pointer: coarse)').matches)
  }

  function selectRange(start: number, end: number) {
    range = { start, end }
    playhead = start
    if (clip.transcript) void selectToken(tokenAtTime(tokens, start), tokenAtTime(tokens, end))
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault()
      togglePlay()
    } else if (event.key === ' ' && document.activeElement !== input) {
      event.preventDefault()
      togglePlay()
    }
  }

  onMount(() => {
    document.addEventListener('selectionchange', handleSelectionChange)
    void decodeClip(clip.dataURL).then((decoded) => { audio = decoded }).catch((error) => console.error('Could not decode voice idea', error))
  })

  onDestroy(() => {
    stop()
    void context?.close()
    for (const timer of unlockTimers) window.clearTimeout(timer)
    document.removeEventListener('selectionchange', handleSelectionChange)
  })
</script>

<svelte:window on:keydown={handleKeydown} />

<OverlayModal title="Voice idea" class="voice-idea" z={66} maxWidth={640} {onClose}>
  <div class="voice-idea-text">
    <!-- Mirrors the textarea underneath it to mark the word at the playhead. -->
    <div class="voice-idea-mirror" aria-hidden="true">{#if spoken}{text.slice(0, spoken.from)}<mark>{text.slice(spoken.from, spoken.to)}</mark>{text.slice(spoken.to)}{:else}{text}{/if}&#8203;</div>
    <textarea
      bind:this={input}
      bind:value={text}
      use:autoGrow={text}
      rows="3"
      placeholder={clip.transcript ? '' : canTranscribe ? '' : 'Transcribes on a Mac'}
      aria-label="Idea text"
      on:input={edit}
      on:select={syncFromSelection}
      on:pointerup={syncFromSelection}
      on:keyup={syncFromSelection}
    ></textarea>
  </div>

  <div class="voice-idea-player">
    <button type="button" class="voice-idea-play" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (⌘↵)' : 'Play (⌘↵)'} on:click={togglePlay}>
      {#if playing}❚❚{:else}▶{/if}
    </button>
    <span class="voice-idea-time">{formatClipDuration(playhead * 1000)} / {formatClipDuration(clip.durationMs)}</span>
    {#if !clip.transcript && canTranscribe}
      <button type="button" class="voice-idea-transcribe" disabled={transcribing} on:click={onTranscribe}>
        {#if $transcriptionStatus.state === 'downloading'}Downloading {Math.round($transcriptionStatus.fraction * 100)}%{:else if transcribing}Transcribing…{:else}Transcribe{/if}
      </button>
    {/if}
  </div>
  <VoiceWaveform bind:this={waveform} peaks={clip.peaks} {durationSeconds} {playhead} {range} onSeek={seek} onSelectRange={selectRange} />

  <div class="idea-move-strip" role="group" aria-label="Move idea to">
    {#each targets as target (target.kind)}
      <button
        type="button"
        class="idea-group-button"
        class:locked={locked(target.kind, unlockTick)}
        disabled={locked(target.kind, unlockTick)}
        on:click={() => onMove(target.kind)}
      >{target.label}</button>
    {/each}
  </div>
</OverlayModal>

<style>
  .voice-idea-text {
    position: relative;
    display: grid;
  }
  .voice-idea-mirror,
  .voice-idea-text textarea {
    grid-area: 1 / 1;
    margin: 0;
    padding: 8px 10px;
    border: 1px solid transparent;
    font: inherit;
    font-size: 16px;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: break-word;
    letter-spacing: normal;
  }
  .voice-idea-mirror {
    color: transparent;
    pointer-events: none;
  }
  .voice-idea-mirror mark {
    border-radius: 3px;
    background: color-mix(in srgb, var(--accent) 22%, transparent);
    color: transparent;
  }
  .voice-idea-text textarea {
    position: relative;
    min-height: 4.5em;
    border-color: var(--line);
    border-radius: 6px;
    background: transparent;
    color: var(--ink);
    resize: none;
    overflow: hidden;
  }
  .voice-idea-player {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px 0 4px;
  }
  .voice-idea-play {
    width: 36px;
    height: 36px;
    padding: 0;
    border-radius: 50%;
  }
  .voice-idea-time {
    color: var(--muted);
    font-size: 13px;
    font-variant-numeric: tabular-nums;
  }
  .voice-idea-transcribe { margin-left: auto; }
  .idea-move-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
    padding-top: 12px;
  }
</style>
