---
name: balance-sync
description: Develop, debug, deploy, or test Balance's multi-device sync and relay systems. Use for the native Rust op-log engine, device pairing, E2EE envelopes, direct TCP sync, relay protocols, checkpoints and generations, the Cloudflare relay Worker, foreground or Android background scheduling, quarantined batches, relay rollback or reset, and sync CI changes. Do not use for unrelated database or UI work.
---

# Balance sync

Work on Balance's multi-device sync without weakening encryption, exposing relay
credentials, inspecting personal application data, or breaking protocol
compatibility.

## Start with the invariants

- Read and obey the repository `AGENTS.md`, especially the public-repository,
  database privacy, worktree, and Android CI rules.
- Never retrieve or use the user's database recovery key, and never open or
  decrypt the user's installed database or a backup. Use generated databases,
  synthetic data, and test-only keys.
- Keep relay secrets out of tracked files. Use environment variables, Wrangler
  secrets, or another gitignored secret store.
- Do not build, initialize, link, emulate, or install Android locally. Exercise
  the generator locally, then verify Android behavior through
  `.github/workflows/android.yml` after pushing.
- Use `pnpm`, not `npm`. Run Cloudflare Wrangler with Node 22 on this machine;
  Node 24.2.0 fails OAuth and API requests with `internalConnectMultiple` or
  `EBADF`.

## Know the architecture

Sync is a native Rust op-log reconciliation engine in `src-tauri/src/sync/`,
with the frontend in `src/lib/SyncPanel.svelte` and automatic foreground
scheduling in `src/lib/syncScheduler.ts`. Devices pair via QR codes and exchange
compressed E2EE envelopes using XChaCha20-Poly1305.

Relay sync uploads only durable incremental operation batches. Direct TCP sync
uses an id-set inventory plus compact per-device checkpoint frontiers. No SQLite
extension is loaded on any platform, so there is nothing sync-specific to
cross-compile for Android. The Android workflow still needs the NDK because it
cross-compiles the vendored OpenSSL linked by SQLCipher.

The app syncs after persisted edits with a two-second debounce, at launch,
resume, and online events, and on a five-minute foreground safety interval.
Android additionally chains network-constrained one-time WorkManager passes at
a best-effort five-minute cadence, because periodic WorkManager requests have a
15-minute minimum. The CI-only generator is
`.github/scripts/configure-android-background-sync.mjs`; never generate or build
that Android project locally.

Malformed delta batches are quarantined locally so one damaged blob does not
prevent later batches from syncing. Preserve that forward-progress behavior
when changing validation or ingestion.

## Run the reference relay safely

Run the Node reference relay with:

```sh
BALANCE_RELAY_SECRET='<24+ url-safe chars>' node scripts/relay-server.mjs
```

It refuses to start without a secret and prints a suggested one. Every route
lives under `/<secret>/`; that path prefix is the access control. Save the relay
URL in the app as the base URL plus that prefix, with no app-side protocol
change. The server binds loopback only unless `BALANCE_RELAY_HOST` overrides it,
so expose it deliberately.

`POST /<secret>/reset` empties the room. Prefer the v3 generation rollback route
when only the current checkpoint is bad.

## Maintain and deploy the Cloudflare relay

`relay-worker/` implements the v3 contract as a Cloudflare Worker. State lives
in a Durable Object because the Worker is stateless and a push must be visible
to the very next pull. Store `RELAY_SECRET` as a Wrangler secret; never place it
in the tracked `wrangler.toml`.

Ciphertext is chunked at 96 KiB because Durable Object storage caps values at
128 KiB. Generations compact after 32 MiB, seven days, or 128 batches. Retain
one prior generation for rollback for 24 hours, then delete it.

From `relay-worker/`, run Wrangler through Node 22, for example:

```sh
pnpm dlx node@22 node_modules/wrangler/bin/wrangler.js deploy
```
