<script lang="ts">
  import { onDestroy, onMount, tick } from 'svelte'
  import OverlayModal from './OverlayModal.svelte'
  import VoiceWaveform from './VoiceWaveform.svelte'
  import { autoGrow } from './autoGrow'
  import { escapeHTML, htmlToPlainTextWithBreaks } from './planner'
  import { IDEA_GROUPS, IDEA_UNLOCK_MS } from './ideas'
  import { alignTranscript, formatClipDuration, isTimed, timeRangeForSelection, tokenAtTime } from './voiceClips'
  import { decodeClip } from './voiceRecorder'
  import { canTranscribe, transcriptionStatus } from './voiceTranscription'
  import type { IdeaGroupKind, IdeaItem, VoiceClip } from './types'

  // Reading a transcript beside its audio: tapping a word plays from there, and
  // the word being spoken is marked as it plays.
  export let clip: VoiceClip
  export let idea: IdeaItem
  export let onEdit: (text: string, html: string) => void
  // Sorting decides with its own choices, so it leaves out the move buttons.
  export let onMove: ((kind: IdeaGroupKind) => void) | undefined = undefined
  export let onTranscribe: () => void
  export let onClose: () => void

  const durationSeconds = clip.durationMs / 1000
  const targets = IDEA_GROUPS.filter((group) => group.kind !== 'proposition')
  const openedAt = Date.now()

  // Line breaks live in the html; the plain text drops them.
  const textOf = (item: IdeaItem) => item.html ? htmlToPlainTextWithBreaks(item.html) : item.text
  let savedText = textOf(idea)
  let text = savedText
  let input: HTMLTextAreaElement
  let waveform: VoiceWaveform
  let playhead = 0
  let playing = false
  let audio: AudioBuffer | null = null
  let context: AudioContext | null = null
  let source: AudioBufferSourceNode | null = null
  let playStartedAt = 0
  let playFrom = 0
  let lastTapAt = 0
  let lastSelection = [-1, -1]
  let tapSeek: { start: number; at: number } | null = null
  let frame = 0
  let unlockTick = 0
  const unlockTimers = targets.map((target) => window.setTimeout(() => { unlockTick += 1 }, IDEA_UNLOCK_MS[target.kind]))

  // A transcript arriving while open lands in the draft unless it has unsaved edits.
  $: adoptSavedText(textOf(idea))
  $: tokens = alignTranscript(text, clip.transcript?.words ?? [], durationSeconds)
  $: spoken = clip.transcript ? tokenAtTime(tokens, playhead) : null
  // Also offered when the transcript never made it into the text.
  $: needsTranscript = clip.transcript
    ? Boolean(clip.transcript.text.trim()) && !tokens.some(isTimed)
    : canTranscribe
  $: transcribing = $transcriptionStatus.state !== 'idle'

  function locked(kind: IdeaGroupKind, _tick: number) {
    return Date.now() < openedAt + IDEA_UNLOCK_MS[kind]
  }

  function adoptSavedText(next: string) {
    if (next === savedText) return
    if (text.trim() === savedText.trim()) text = next
    savedText = next
  }

  function edit() {
    const trimmed = text.trim()
    onEdit(trimmed, escapeHTML(trimmed).replace(/\n/g, '<br>'))
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

  async function play(from: number) {
    stop()
    await ensureAudio()
    if (!audio || !context) return
    const start = from >= durationSeconds - 0.05 ? 0 : from
    source = context.createBufferSource()
    source.buffer = audio
    source.connect(context.destination)
    source.onended = () => { stop() }
    source.start(0, start)
    playStartedAt = context.currentTime
    playFrom = start
    playing = true
    const follow = () => {
      if (!playing || !context) return
      playhead = Math.min(durationSeconds, playFrom + context.currentTime - playStartedAt)
      waveform?.follow(playhead)
      frame = requestAnimationFrame(follow)
    }
    follow()
  }

  function togglePlay() {
    if (playing) {
      stop()
      return
    }
    waveform?.reveal(playhead, false)
    void play(playhead)
  }

  // The playhead follows the caret as you read; a tap on a word also jumps
  // playback there. Typing while it plays leaves playback alone.
  function syncFromSelection(tapped = false) {
    if (!input || !clip.transcript) return
    const changed = input.selectionStart !== lastSelection[0] || input.selectionEnd !== lastSelection[1]
    lastSelection = [input.selectionStart, input.selectionEnd]
    if (!changed && !tapped) return
    const selected = timeRangeForSelection(tokens, input.selectionStart, input.selectionEnd)
    if (!selected) return
    if (playing) {
      const repeat = tapSeek && tapSeek.start === selected.start && performance.now() - tapSeek.at < 500
      if (tapped && input.selectionStart === input.selectionEnd && !repeat) {
        tapSeek = { start: selected.start, at: performance.now() }
        waveform?.reveal(selected.start, false)
        void play(selected.start)
      }
      return
    }
    playhead = selected.start
    waveform?.reveal(selected.start)
  }

  // Touch browsers can place the caret after the tap's events, so a selection
  // change right after a tap counts as the tap.
  function handleSelectionChange() {
    if (document.activeElement === input) syncFromSelection(performance.now() - lastTapAt < 500)
  }

  function handleTap() {
    lastTapAt = performance.now()
    syncFromSelection(true)
  }

  async function seek(seconds: number) {
    playhead = seconds
    waveform?.reveal(seconds)
    if (playing) void play(seconds)
    await tick()
    document.querySelector('.voice-idea-mirror mark')?.scrollIntoView({ block: 'nearest' })
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
      on:select={() => syncFromSelection()}
      on:click={handleTap}
      on:keyup={() => syncFromSelection()}
    ></textarea>
  </div>

  <div class="voice-idea-player">
    <button type="button" class="voice-idea-play" aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (⌘↵)' : 'Play (⌘↵)'} on:click={togglePlay}>
      {#if playing}❚❚{:else}▶{/if}
    </button>
    <span class="voice-idea-time">{formatClipDuration(playhead * 1000)} / {formatClipDuration(clip.durationMs)}</span>
    {#if needsTranscript}
      <button type="button" class="voice-idea-transcribe" disabled={transcribing} on:click={onTranscribe}>
        {#if $transcriptionStatus.state === 'downloading'}Downloading {Math.round($transcriptionStatus.fraction * 100)}%{:else if transcribing}Transcribing…{:else}Transcribe{/if}
      </button>
    {/if}
  </div>
  <VoiceWaveform bind:this={waveform} peaks={clip.peaks} {durationSeconds} {playhead} onSeek={seek} />

  {#if onMove}
  <div class="idea-move-strip" role="group" aria-label="Move idea to">
    {#each targets as target (target.kind)}
      <button
        type="button"
        class="idea-group-button"
        class:locked={locked(target.kind, unlockTick)}
        disabled={locked(target.kind, unlockTick)}
        on:click={() => onMove?.(target.kind)}
      >{target.label}</button>
    {/each}
  </div>
  {/if}
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
