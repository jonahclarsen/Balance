# Voice ideas

The record button in Proposition Party captures an idea by voice. Recording uses
the WebView's microphone (`MediaRecorder`, WebM/Opus at 128 kbps). On Android,
Balance asks for the Nearby devices (Bluetooth) permission the first time so a
connected headset's microphone is used; elsewhere the system input is used.
Recording needs the app in the foreground.

## Storage

Each clip is a `voiceClips` record (`src/lib/types.ts`) holding the audio as a
data URL, its duration, 20-per-second loudness peaks and, once transcribed, the
transcript with word times. It syncs like any other entity collection.

A clip lives only while its idea is in Proposition Party: every local commit
runs `reconcileVoiceClips`, so sorting, deleting, merging or moving the idea to
a day deletes the audio in the same operation. Undo restores it. Untranscribed
recordings are skipped by Sort and by the sort before day generation.

## Transcription (macOS)

Transcribe sends 16 kHz PCM to the `transcribe_voice_clips` command, which runs
`balance-transcriber` (`src-tauri/macos/BalanceTranscriber`, built by
`scripts/build-macos-transcriber.mjs` and bundled in `Contents/MacOS`). It uses
FluidAudio's Parakeet models in `~/Library/Application Support/FluidAudio/Models`,
the directory VoiceInk also uses: an installed v3 is preferred, then v2, and v3
is downloaded only when neither is present. Each new helper binary spends about
20 seconds compiling for the Neural Engine on its first run. `tauri dev` uses
`src-tauri/target/macos-transcriber/balance-transcriber`; run the build script
once in a checkout.

## Review

Clicking a clip's chip opens the transcript above a scrolling waveform.
Selecting text moves the waveform to where it was said; clicking the waveform
selects the word spoken there. Edits keep their alignment by matching words to
the transcript (`alignTranscript`). ⌘↵ plays the selection.
