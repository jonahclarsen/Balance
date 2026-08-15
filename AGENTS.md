# Balance — agent guidance

## Always work in an isolated worktree

Before changing any code or project files, create a dedicated Git worktree and
make the complete change there. The main checkout is often running Balance in
development mode for normal use, so incomplete edits there cause disruptive
rebuilds and visible UI churn. Test and finish the work in the worktree first;
only then bring the completed change onto `main`, resolve any integration issues,
and push it. Once the change is integrated and pushed, completely remove the
dedicated worktree and delete its temporary branch so no worktree directory or
stale Git worktree metadata is left behind. Do not use the main checkout as a
live editing workspace.

## This is a public repo — never commit secrets

Balance is open source and the remote is public. Never commit API keys, tokens,
passwords, private keys, sync/relay credentials, or personal data — anything
pushed here is world-readable and stays in the git history even after removal.
Keep secrets in untracked local files (`.env*`, gitignored) or the OS keychain,
and reference them via environment variables. In CI, use GitHub Actions secrets.
Before committing, check the diff for anything credential-shaped; if a secret
does get pushed, treat it as compromised and rotate it.

## Never decrypt or inspect the user's database

While working on Balance, never retrieve, reveal, export, or use the user's
database recovery key, including through the OS keychain or Android Keystore.
Never open or decrypt the user's installed database, a backup of it, or a copy
of it, and never use personal application data as a migration or test fixture.

All database, migration, recovery, backup, and sync tests must use databases
generated specifically for testing with synthetic data and test-only keys. If a
problem cannot be reproduced with generated fixtures, stop and explain what the
user can verify themselves without exposing their key or database contents.

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
with the frontend in `src/lib/SyncPanel.svelte` and automatic foreground
scheduling in `src/lib/syncScheduler.ts`. Devices pair via QR codes and exchange
compressed E2EE envelopes (XChaCha20-Poly1305). Relay sync uploads only durable
incremental operation batches; direct TCP sync uses an id-set inventory plus
compact per-device checkpoint frontiers. Legacy v2 id tombstones remain only for
migration. No SQLite extension is loaded on any platform.

Run the reference relay with
`BALANCE_RELAY_SECRET=<24+ url-safe chars> node scripts/relay-server.mjs`; it
refuses to start without a secret and prints a suggested one. Every route lives
under `/<secret>/`, which is the access control — the relay URL saved in the app
is the base plus that prefix, so no app-side change is needed. It binds loopback
only (override with `BALANCE_RELAY_HOST`), so expose it deliberately.

For always-on sync that does not depend on a dev box being awake, `relay-worker/`
implements the v3 contract as a Cloudflare Worker (`npx wrangler deploy` from
that directory). State lives in a Durable Object because the Worker is stateless
and a push must be visible to the very next pull. `RELAY_SECRET` is a wrangler
secret — never put it in `wrangler.toml`, which is committed to this public repo.
Ciphertext is chunked at 96 KiB because Durable Object storage caps values at
128 KiB. Generations compact after 32 MiB, seven days, or 128 batches; one prior
generation is retained for rollback for 24 hours and then deleted.

The app syncs after persisted edits (2-second debounce), at launch/resume/online,
and on a five-minute foreground safety interval. Android additionally schedules
a network-constrained WorkManager pass at the platform minimum 15-minute period;
`.github/scripts/configure-android-background-sync.mjs` patches the generated
Android project in CI. Never generate or build that project locally.

`POST /<secret>/reset` empties the room. Prefer the v3 generation rollback route
for a bad current checkpoint. Malformed delta batches are quarantined locally so
one damaged blob does not prevent later batches from syncing.
