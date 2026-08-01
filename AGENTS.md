# Balance — agent guidance

## This is a public repo — never commit secrets

Balance is open source and the remote is public. Never commit API keys, tokens,
passwords, private keys, sync/relay credentials, or personal data — anything
pushed here is world-readable and stays in the git history even after removal.
Keep secrets in untracked local files (`.env*`, gitignored) or the OS keychain,
and reference them via environment variables. In CI, use GitHub Actions secrets.
Before committing, check the diff for anything credential-shaped; if a secret
does get pushed, treat it as compromised and rotate it.

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

Sync loads no SQLite extension on any platform, so there is nothing
sync-specific to cross-compile for Android. The NDK setup in the workflow is
still required — the vendored OpenSSL that SQLCipher links against is
cross-compiled with it.

## Multi-device sync

Sync is a native Rust op-log reconciliation engine in `src-tauri/src/sync/`,
with the frontend in `src/lib/SyncPanel.svelte`. Devices pair via QR codes and
exchange E2EE sealed envelopes (XChaCha20-Poly1305) over direct TCP, discovering
each other with mDNS. Reconciliation is an id-set diff of the append-only
operations log; compaction uses checkpoint ops carrying a `replaces` list plus a
`sync_tombstones` table. No SQLite extension is loaded on any platform, so sync
has no platform-specific build step.

Run the reference relay with
`BALANCE_RELAY_SECRET=<24+ url-safe chars> node scripts/relay-server.mjs`; it
refuses to start without a secret and prints a suggested one. Every route lives
under `/<secret>/`, which is the access control — the relay URL saved in the app
is the base plus that prefix, so no app-side change is needed. It binds loopback
only (override with `BALANCE_RELAY_HOST`), so expose it deliberately.
