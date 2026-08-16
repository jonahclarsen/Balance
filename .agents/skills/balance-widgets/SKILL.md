---
name: balance-widgets
description: Develop, debug, secure, build, install, or test Balance's macOS WidgetKit and Android AppWidget integrations. Use for widget discovery or Edit Widgets failures, macOS dev-mode clicks and deep links, encrypted widget database/cache access, snapshot schema or rendering changes, task indentation and time labels, extension signing or registration, and Android widget generator or CI changes. Do not use for unrelated Balance UI work.
---

# Balance widgets

Work on Balance's macOS and Android widgets without weakening database security,
breaking dev mode, or repeating the installation and registration mistakes that
make a valid-looking widget disappear from the system gallery.

## Start with the invariants

- Read and obey the repository `AGENTS.md`, especially the rules against
  inspecting the user's database or recovery key and against local Android
  builds.
- Never retrieve, print, export, or use the user's database recovery key.
- Never open or decrypt the user's installed database as part of a test. Use
  Rust unit tests with synthetic JSON or generated encrypted test databases.
- Never add a plaintext widget cache. Task text, reminders, times, and hierarchy
  are private plan data even if the widget displays them.
- Keep the macOS widget-private key inside the widget's Keychain access group and
  device. Do not share it with the host app, store it in preferences, or replace
  it with the database key.
- Keep Android widget task and reminder text confined to the home screen.
- Do not build, initialize, link, emulate, or install Android locally. Test the
  generator locally, then use `.github/workflows/android.yml` in CI.
- Use `pnpm`, not `npm`.
- Whenever widget work produces durable, verified knowledge about architecture,
  security, lifecycle, signing, registration, build behavior, performance, or
  testing, update this skill in the same change. Treat that update as part of
  finishing the widget work. Record reusable evidence, not unverified guesses or
  one-off machine state.

## Know the architecture

Read only the files relevant to the requested change:

- `src-tauri/src/widget.rs`: shared serialized snapshot, preorder tree flattening,
  incomplete-task selection, indentation depth, time labels, and unit tests.
- `src-tauri/src/macos_widget.rs`: reads today's plan through the already-open
  native database connection, serializes the snapshot, and passes it to Swift.
- `src-tauri/macos/WidgetBridge.swift`: host-side public-key lookup, snapshot
  encryption and persistence, WidgetKit reloads, and release-to-dev activation.
- `src-tauri/build.rs`: compiles the host Swift bridge and links AppKit, Security,
  and WidgetKit into the Rust app.
- `src-tauri/macos/BalanceWidget/BalanceWidget.swift`: WidgetKit timeline,
  decryption, backward-compatible decoding, privacy marking, and rendering.
- `src-tauri/macos/BalanceWidget.xcodeproj`: the real WidgetKit extension target.
- `scripts/build-macos-widget.mjs`: universal Xcode build and extension signing.
- `scripts/macos-tauri-cargo.sh`: macOS Cargo pass-through that injects the dev
  process runner only for `cargo run`.
- `scripts/run-macos-dev-app.sh`,
  `src-tauri/macos/BalanceWidgetDevBridge.swift`, and
  `src-tauri/macos/BalanceWidgetDevBridgeInfo.plist`: compile and supervise the
  persistent, zero-payload WidgetKit reload bridge used by the raw dev host.
- `src-tauri/tauri.macos.conf.json`: selects the macOS dev runner and copies the
  built `.appex` into production apps at `Contents/PlugIns`.
- `src-tauri/src/android_widget.rs`: JNI entry point that reads SQLCipher directly
  and returns the shared snapshot without persisting a second copy.
- `.github/scripts/configure-android-widgets.mjs`: generates the provider, layouts,
  manifest entries, activity hooks, and worker hooks in CI.
- `.github/scripts/configure-android-widgets.test.mjs`: idempotence and security
  assertions for the Android generator.

## Preserve the snapshot contract

The serialized snapshot currently contains:

- `date`, `hasPlan`, `unavailable`, `title`, `reminder`, `done`, and `total`;
- `items`: up to ten incomplete, non-empty tasks in preorder;
- `itemDepths`: an index-aligned depth for each item;
- `itemTimes`: an index-aligned visible time-range label for each item;
- `themeId`: the active replicated color preset, with `violet` as the fallback.

Keep `items`, `itemDepths`, and `itemTimes` exactly aligned after filtering and
truncation. Progress counts cover every non-empty task, including completed
tasks and descendants; the visible list contains incomplete tasks only. Depth
comes from the nested `children` tree used by the app itself.

Match the app's time behavior:

- Show a label only when both `startMinutes` and `endMinutes` exist and
  `timeHidden` is not true.
- Use the app's 12-hour formatting (`9am`, `10:15am`) and normalize minutes
  modulo 24 hours.
- Render the range before task text, with an en dash between endpoints.

Treat an encrypted snapshot as potentially older than the extension. Make new
Swift fields optional and use safe index access. In generated Kotlin, use
`optJSONArray`, `optString`, `optInt`, or equivalent defaults rather than making
an older payload fatal. If a field becomes required by the Android reader,
update the JNI error fallback JSON too.

Keep widget palette definitions aligned with the light and dark CSS variables in
`src/app.css`. macOS follows both `themeId` and the system color scheme. Android
uses generated preset-specific RemoteViews resources because older RemoteViews
APIs cannot reliably tint every rounded drawable at runtime. Unknown and legacy
theme values must render with the `violet` preset.

Treat the macOS widget as the reference design and preserve visual parity in the
Android home widget wherever both platforms can express the same design. When a
shared element changes on either platform, compare its content order, typography,
spacing, palette, task-row treatment, progress presentation, and empty state on
the other platform in the same change. Keep intentional platform controls, such
as Android's manual refresh action, when parity would remove useful native
behavior. Android's generated `layout-night` and `drawable-night` resources must
stay aligned with the macOS dark palettes as well as the default resources with
the light palettes.

The populated Android widget mirrors macOS by placing the plain muted daily
quote above the progress bar, rendering task rows inside a rounded bordered
surface with dividers, showing visible time ranges in accent capsules, and using
an explicit accent-colored `All done` state when no incomplete tasks remain.
Keep generator tests for these structural relationships so a preview-only layout
change cannot silently make the platforms drift.

For macOS task rows, preserve `.privacySensitive()`. Clamp visual indentation so
deep trees do not consume the full widget. For Android, use non-breaking spaces
or another RemoteViews-compatible technique because leading ordinary spaces may
not render reliably.

## Maintain the macOS security boundary

The extension owns a P-256 private key tagged
`app.balance.local.widget.snapshot-key.v2`. It prefers Secure Enclave and falls
back to a Keychain key with `kSecAttrAccessibleWhenUnlockedThisDeviceOnly`. The
host sees only the public key and encrypts the JSON with
`eciesEncryptionCofactorX963SHA256AESGCM`.

Preference keys and domains are deliberately asymmetric:

- The extension publishes public key material as
  `balance.widget.public-key.v2` in its sandboxed standard preferences.
- The host writes ciphertext as `balance.widget.encrypted-snapshot.v2` in the
  explicit `app.balance.local` suite.
- `balance.widget.snapshot.v1` is the retired plaintext key and must remain
  deleted.

Do not simplify this into a normal suite lookup. The raw, unsandboxed
`target/debug/Balance` process can resolve `UserDefaults(suiteName:)` for the
extension identifier to a global preference domain, while the extension's
`UserDefaults.standard` is stored in its sandbox container at:

`~/Library/Containers/app.balance.local.widget/Data/Library/Preferences/app.balance.local.widget.plist`

The bridge reads the flushed extension plist directly only to obtain the public
key. The private key never leaves Keychain. The decrypted snapshot exists only
in widget-process memory long enough to decode and render it.

When diagnosing preferences, check key presence or type only. Do not print
preference values, inspect a decrypted snapshot, or use the user's plan as a
fixture. In particular, a command intended to prove the legacy plaintext key is
absent must not print its value if it unexpectedly exists.

## Build a real macOS extension

Use the Xcode target. Do not hand-assemble an `.appex` with `swiftc`. A manually
compiled bundle can have plausible metadata and signatures while missing the
extension entry point (`_NSExtensionMain`), so macOS never lists it in Edit
Widgets.

The normal production build is:

```sh
APPLE_SIGNING_IDENTITY='<local identity hash or name>' pnpm tauri build --bundles app
```

Never commit the local signing identity. The extension is first built unsigned
by Xcode, then signed by `scripts/build-macos-widget.mjs`; the containing app is
signed by Tauri. For a real installation, use the same signing team for the
extension and host. Verify before installation:

```sh
codesign --verify --deep --strict --verbose=2 src-tauri/target/release/bundle/macos/Balance.app
codesign -dv --verbose=2 src-tauri/target/release/bundle/macos/Balance.app/Contents/PlugIns/BalanceWidget.appex
```

`pnpm build` also runs the macOS widget build on macOS. Set
`BALANCE_SKIP_MACOS_WIDGET=1` only for a workflow that intentionally does not
need the extension.

## Use the persistent macOS dev reload bridge

The raw Tauri dev host cannot reliably call `WidgetCenter` itself. A synthetic
minimal app shell can enumerate configured `BalanceToday` widgets and reload
them, but that result does not transfer to the real Balance binary. Unified logs
show the actual Tauri process returning `ChronoCoreErrorDomain` code 27 for every
reload request even when all of the following are tested:

- a hard link or APFS clone inside a correctly identified `.app`;
- an unsigned, ad-hoc-signed, or Developer-ID-signed outer app;
- no extension, a symlink to the installed extension, or a physical signed copy
  of the extension inside the shell.

Do not use configuration enumeration as proof that the real host can invalidate
a timeline, and do not return to the dev app-shell design. The working boundary
is a tiny Swift executable that is the declared main executable of its own
`BalanceWidgetDevBridge.app`. It has the production container bundle identifier
but no URL schemes and no embedded extension. It listens only for the
zero-payload distributed notification `app.balance.local.widget.reload` and
calls `reloadTimelines(ofKind: "BalanceToday")`.

Normal `pnpm tauri dev` uses the macOS-only Cargo runner. On each Rust process
start, `scripts/run-macos-dev-app.sh`:

1. compiles the bridge only when its ignored target binary is absent or stale;
2. launches it with the soon-to-be dev process PID and waits for its ready file;
3. `exec`s the raw `target/debug/Balance` process;
4. relies on the bridge's parent-PID monitor to exit after that dev process dies.

The host publishes encrypted ciphertext first, then posts the notification. No
task data, key material, or ciphertext crosses that notification, and no process
is launched per task change. Measured on this machine, the first bridge compile
and launch took about 680 ms; subsequent cached Rust-process starts took about
30 ms. A task change only posts the notification. Re-profile if the bridge or
runner changes materially.

Keep `/Applications/Balance.app` as the sole installed extension container and
`balance://` handler. The dev bridge intentionally declares neither an extension
nor a URL scheme. After bridge changes, verify a successful reload in unified
logs, exactly one `pluginkit` result rooted under `/Applications/Balance.app`,
and Launch Services URL resolution to `/Applications/Balance.app`. Never print
widget payloads during those checks.

## Install and register macOS correctly

`tauri dev` does not install a WidgetKit extension. Opening
`src-tauri/target/release/bundle/macos` merely opens a directory; it does not
install or launch the app. Launching the build-tree `.app` is also not a durable
substitute for installing the bundle under `/Applications`.

Use this sequence, adapting explicit paths after read-only checks:

1. Inspect every `Balance` process and distinguish
   `/Applications/Balance.app/Contents/MacOS/Balance` from
   `target/debug/Balance`. Never terminate the dev process by name alone.
2. Verify the new bundle and embedded extension signatures.
3. Unregister the extension embedded in the old installed app.
4. Move the old `/Applications/Balance.app` to a unique, explicit Trash backup;
   do not recursively delete it.
5. Copy the new `Balance.app` itself to `/Applications`, for example with
   `ditto`. Do not copy or open the containing `bundle/macos` directory.
6. Force-register `/Applications/Balance.app` with Launch Services and register
   only `/Applications/Balance.app/Contents/PlugIns/BalanceWidget.appex` with
   `pluginkit`.
7. Unregister any extension automatically registered from a build-tree app.
8. Restart `BalanceWidget` and `chronod`; macOS will relaunch them.
9. Verify registration with:

```sh
pluginkit -m -A -D -v -i app.balance.local.widget
```

Expect exactly one enabled result, rooted under `/Applications/Balance.app`.
Duplicate entries—especially one under `src-tauri/target`—can make testing look
random because macOS may use the stale copy.

Extension Swift changes require a signed rebuild, reinstall, re-registration,
and WidgetKit process restart. Rust host changes can rebuild during `tauri dev`,
but the installed extension itself is not hot-reloaded.

Never ask the user to evaluate a macOS widget change after only compiling the
extension or app. Before handoff, replace the installed app, re-register and
restart the extension, and compare the installed widget executable hash with the
new signed build. A successful build does not prove that WidgetKit is running
that build.

This user normally runs Balance through `tauri dev`. After installing a new
extension, also force one production-host refresh before handoff:

1. Launch `/Applications/Balance.app` once as a registration and handoff nudge.
   Its release-to-dev preflight should activate the running dev app and make the
   installed production host exit automatically. If the exact production process
   remains, quit only `/Applications/Balance.app/Contents/MacOS/Balance`.
2. Confirm that the active dev host publishes the encrypted snapshot and requests
   a WidgetKit timeline reload through lifecycle events or preference-file
   modification time, without printing snapshot contents.

After the installed extension is registered, refreshed, and hash-verified,
delete regenerable production build outputs to save disk space: `dist/`,
`src-tauri/target/release/`, `src-tauri/target/macos-widget/`, and
`src-tauri/target/macos-widget-xcode/`. Never delete all of `src-tauri/target/`,
because the user relies on its debug build and cache for dev mode. Do not delete
`/Applications/Balance.app`: macOS needs that installed container to keep the
widget extension registered even though the host app is normally run in dev.

## Preserve dev-mode widget clicks

The widget uses `balance://today`. Launch Services resolves this URL to the
installed app even while `tauri dev` runs the raw `target/debug/Balance`
executable. The persistent bridge declares no URL scheme.

The installed release binary therefore performs a preflight before Tauri or
database initialization:

1. Find another running application whose executable ends with
   `/src-tauri/target/debug/Balance`. The matcher may retain the retired
   `/BalanceDev.app/Contents/MacOS/Balance` form only for upgrade compatibility.
2. Ask AppKit to activate all of that process's windows.
3. Exit the installed release immediately.
4. Start the installed app normally only when no matching dev process exists.

Do not use `NSRunningApplication.activate`'s Boolean result as the handoff
condition. It can return false when the dev app is already frontmost even though
the correct process was found. Detection is sufficient reason to exit.

Before probing the installed executable, independently confirm that AppKit sees
the expected dev process. Otherwise a failed probe would continue into
normal startup and touch the user's database. After a safe probe or an actual
`open 'balance://today'`, verify that only the debug process remains. If an
installed release was already running before dev mode started, stop that exact
installed process first so the startup preflight can run; do not kill the debug
process.

If the project changes its target directory or binary name, update the path
matcher and its verification procedure together.

## Keep Android secure and generated

The Android home widget does not use a plaintext snapshot. Its provider calls
the Rust JNI function, which:

1. resolves the app's SQLCipher database;
2. unwraps the database key through Android Keystore only for that read;
3. holds the local key copy in `Zeroizing` memory;
4. opens SQLCipher, reads today's plan, serializes the shared snapshot, and
   returns it in memory;
5. persists no task snapshot or database key.

Keep the widget receiver non-exported. Changes to the provider, RemoteViews,
layouts, the manifest, activity refresh hooks, or background-worker refresh
hooks belong in `.github/scripts/configure-android-widgets.mjs`, not in a locally
generated Android tree.

Keep the Android manual refresh action connected to the relay sync worker, which
redraws the widget after a successful pass. A local snapshot redraw alone cannot
retrieve changes made on another device. Preserve a minimum 48dp touch target
around the refresh control even when its visible treatment is smaller.

Run only the generator test locally:

```sh
node --test .github/scripts/configure-android-widgets.test.mjs
```

After committing and pushing an Android widget change, dispatch or monitor the
Android workflow on the pushed ref as appropriate. Do not substitute a local
Gradle, NDK, emulator, or `tauri android` run.

## Validation workflow

Choose checks proportional to the change, but use the full set before handing
off a cross-platform widget change:

```sh
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml widget::tests
cargo test --manifest-path src-tauri/Cargo.toml
pnpm check
sh -n scripts/macos-tauri-cargo.sh scripts/run-macos-dev-app.sh
swiftc -typecheck src-tauri/macos/BalanceWidgetDevBridge.swift
node --test .github/scripts/configure-android-widgets.test.mjs
```

On macOS, also build the signed `.app`, verify nested signatures, install the
actual app under `/Applications`, eliminate duplicate plugin registrations, and
confirm the URL handoff without accessing the user's database. Use unified logs
only for lifecycle or decryption-success diagnostics; do not log or print plan
contents, keys, or preference values.

Before committing:

- inspect the diff for secrets and machine-specific signing data;
- confirm no legacy plaintext cache was reintroduced;
- confirm new snapshot fields degrade safely with older payloads;
- confirm macOS private content remains privacy-sensitive;
- confirm Android widget content remains home-screen-only;
- follow the repository's amend-versus-new-commit and push rules.
