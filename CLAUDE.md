# Balance — agent guidance

## Android: CI only — never build locally

Do **not** build, link, or run anything Android locally (no `tauri android build`,
no `tauri android init`, no Android SDK/NDK/gradle/emulator installs). The local
dev box doesn't have the toolchain and the disk is tight; attempting it wastes
time and risks the environment.

All Android verification happens in CI: `.github/workflows/android.yml` builds the
debug APK (arm64 + x86_64) and runs an emulator smoke test. To validate Android
changes, push the branch and let that workflow run.

What *is* fine locally for the sync engine: cross-compiling the cr-sqlite **static
libs** for Android (`scripts/build-crsqlite.sh android`) — that's pure `cargo`
against the installed android rust-std, needs no NDK, and is what `build.rs` links.
Everything else Android-shaped is CI's job.

## Multi-device sync (cr-sqlite)

E2EE sync built on the Superfly cr-sqlite fork lives in `src-tauri/src/sync/`
(engine, migration, transports, pairing) with the frontend in
`src/lib/SyncPanel.svelte`. Build the extension with `scripts/build-crsqlite.sh`;
run the reference relay with `node scripts/relay-server.mjs`. See the project
memory for the full design and current state.
