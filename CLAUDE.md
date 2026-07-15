# Balance — agent guidance

## Always commit and push after making changes

After completing a code change, always commit it and push to the remote — don't
leave work uncommitted. Use a clear commit message describing the change.

When the change is a follow-up to the most recent commit (fixing, tweaking, or
extending what it did), don't make a new commit — amend the most recent commit
and force-push with lease (`git commit --amend` then `git push --force-with-lease`).

## Keep the keyboard-shortcuts reference in sync

Keyboard shortcuts live in `handleGlobalKeydown` in `src/App.svelte`, and the
user-facing reference is a hand-maintained list in
`src/lib/KeyboardShortcutsModal.svelte` (opened with `?`). These can drift.
Whenever you add, remove, or change a shortcut in `handleGlobalKeydown`, update
`KeyboardShortcutsModal.svelte` in the same change so the modal stays accurate.

## Android: CI only — never build locally

Do **not** build, link, or run anything Android locally (no `tauri android build`,
no `tauri android init`, no Android SDK/NDK/gradle/emulator installs). The local
dev box doesn't have the toolchain and the disk is tight; attempting it wastes
time and risks the environment.

All Android verification happens in CI: `.github/workflows/android.yml` builds the
debug APK (arm64 + x86_64) and runs an emulator smoke test. To validate Android
changes, push the branch and let that workflow run.

The cr-sqlite engine loads at runtime (`load_extension`) on every platform —
including Android — so the APK build does NOT link it. The Android loadable
extension (`crsqlite.so`) is cross-compiled by `scripts/build-crsqlite.sh android`
(needs the NDK clang, so CI only) and is bundled + loaded at runtime separately.
Static-linking was attempted and abandoned: cr-sqlite's `sqlite3_crsqlite_init`
lives in its C wrapper and static integration needs the host SQLite recompiled
with `-DSQLITE_EXTRA_INIT`, which rusqlite's bundled SQLCipher doesn't do.
Remaining Android-runtime work: bundle `crsqlite.so` per-ABI and resolve its path
at load time (jniLibs / nativeLibraryDir).

## Multi-device sync (cr-sqlite)

E2EE sync built on the Superfly cr-sqlite fork lives in `src-tauri/src/sync/`
(engine, migration, transports, pairing) with the frontend in
`src/lib/SyncPanel.svelte`. Build the extension with `scripts/build-crsqlite.sh`;
run the reference relay with `node scripts/relay-server.mjs`. See the project
memory for the full design and current state.
