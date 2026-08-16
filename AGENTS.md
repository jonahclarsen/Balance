# Balance — agent guidance

## Work in an isolated worktree except for one-edit changes

Before changing any code or project files, create a dedicated Git worktree and
make the complete change there. The main checkout is often running Balance in
development mode for normal use, so incomplete edits there cause disruptive
rebuilds and visible UI churn. Test and finish the work in the worktree first;
only then bring the completed change onto `main`, resolve any integration issues,
and push it. Once the change is integrated and pushed, completely remove the
dedicated worktree and delete its temporary branch so no worktree directory or
stale Git worktree metadata is left behind. Do not use the main checkout as a
live editing workspace.

Exception: if a change is genuinely trivial and can be completed with a single
edit tool call, make it directly on `main` instead of creating a worktree. If it
requires a second edit or expands in scope, move the work to a dedicated
worktree before continuing.

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

Never take screenshots of the app running with the user's real data, or access
it in any other way.

All database, migration, recovery, backup, and sync tests must use databases
generated specifically for testing with synthetic data and test-only keys. If a
problem cannot be reproduced with generated fixtures, stop and explain what the
user can verify themselves without exposing their key or database contents.

## Always commit and push after making changes

After completing a code change, always commit it and push to the remote — don't
leave work uncommitted. Use a clear commit message describing the change.

Watch out for changes and commits happening while you are working, be sure to
keep commits separate.

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
