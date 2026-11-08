# Voice ideas

The record button on the Ideas page and in the Add idea dialog captures an idea
by voice into Proposition Party; the dialog puts its typed text in the clip's
idea, and closing it mid-recording saves like Save. Recordings are never
discarded: Stop always saves. Recording uses the WebView's microphone through an
`AudioContext` into `MediaRecorder` (WebM/Opus at 128 kbps), so the microphone
can change mid-recording. On Android,
Balance asks for the Nearby devices (Bluetooth) and notification permissions the
first time so a connected headset's microphone is used; elsewhere the system
input is used. A microphone foreground service keeps Android recording while the
app is in the background and shows a notification with the app's logo and a
Stop button, which saves the clip.

On Android, mic buttons shown while recording switch between the headset and the
phone; the choice is remembered for the next recording. A headset's
microphone forces Bluetooth's call profile. The phone choice records without
voice processing from the named built-in input, which keeps Chromium out of
Android's call mode so music keeps playing normally.

Chunks are written to IndexedDB (`src/lib/voiceChunkStore.ts`) as they are
captured. If the app closes mid-recording, the next launch saves what was written
as a normal clip, which then syncs. Until a clip is saved these chunks sit
outside the encrypted database, in the app's private WebView storage.

## Storage

Each clip is a `voiceClips` record (`src/lib/types.ts`) holding the audio as a
data URL, its duration, 20-per-second loudness peaks and, once transcribed, the
transcript with word times. It syncs like any other entity collection.

A transcribed clip lives only while its idea is in Proposition Party: every
local commit runs `reconcileVoiceClips`, so sorting, deleting, merging or moving
the idea to a day deletes the audio in the same operation. Undo restores it.
Until its transcript arrives the audio is the idea's only content, so an
untranscribed clip stays with its idea in any idea group and is dropped when the
transcript fills the idea. Sort and the sort before day generation show
untranscribed recordings with their chip, but hide Add to day, Add to new note,
Cut and Append to previous for them, since those take the idea out of the
groups.

## Transcription (macOS)

The Mac app transcribes every untranscribed clip on its own once the workspace
loads and whenever a new one arrives, locally or by sync, trying each clip once
per launch; the Ideas page's Transcribe button retries failures. Transcribe sends 16 kHz PCM to the `transcribe_voice_clips` command, which runs
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
