# Retro theme performance

The opt-in `retro-theme-profile.yml` workflow compares release builds with generated
planner data. It never reads an installed database or a recovery key. Run it on CI;
performance suites must not run on the shared development machine.

## Workloads

| Workload | Plans × tasks | Lists × tasks | Goals | Existing operations |
| --- | ---: | ---: | ---: | ---: |
| Standard | 365 × 20 | 180 × 20 | 80 | 10,000 |
| Decade | 3,650 × 50 | 1,000 × 50 | 200 | 10,000 |
| Dense | 365 × 1,000 | 180 × 20 | 80 | 10,000 |

The decade workload contains 232,500 tasks; dense contains 368,600 and puts 1,000
on the visible day. The synthetic native bridge supplies hydration snapshots and
acknowledges operations, avoiding localStorage quotas and per-key snapshot writes.
It measures frontend work, not SQLite, encryption, IPC latency or relay traffic.
The separate encrypted undo profile exercises a real generated 90,000-task database.

## Reproduce

Start with one theme, one workload and one round. Check the actual applied theme,
startup measurement, CPU profile and screenshots before dispatching a full matrix:

```sh
gh workflow run retro-theme-profile.yml --ref <candidate> \
  -f baseline_ref=<baseline> -f experiments=baseline -f rounds=1 \
  -f 'themes=["windowsvista"]' -f 'sizes=["standard"]' \
  -f 'runners=["ubuntu-24.04"]'
```

For a matched comparison, set `experiments=baseline`, `rounds=5`, and leave the
runner/workload/theme defaults. `color_scheme=dark` and `sizes=["dense"]` exercise
the dark appearance with a long visible task list. Windows 98 is retired and is
not a valid device-theme benchmark; historical rendering remains supported.

To explore rendering interventions without changing application CSS, select a
comma-separated subset of `sidebar-style`, `sidebar-layout`, `sidebar-layer`,
`header-layer`, `panel-style`, `panel-layout`, `workspace-style`, `row-style`,
`row-layout`, `sidebar-no-blur`, and `header-no-blur`, together with `baseline`.
These interventions are diagnostic only. They are never enabled in the app.

## Measurement and appearance checks

Both revisions use the same copied harness and are built once per job. Revisions
alternate within each round; intervention order reverses on alternate rounds.
Chromium uses 6× CPU throttling and one browser worker. Linux and Intel macOS
results are separate samples, not interchangeable baselines.

Startup records when the expected task editor and theme become available. Before
measuring idle/interaction costs and screenshots, the harness also waits for fonts
and all deferred Goal Rhythm rows. The fixture clock advances from a fixed noon
using the native monotonic clock: it preserves real debounce timing, animation
frames, high-resolution Performance marks and CDP metrics. Playwright's clock
replacement must not be used here because it replaces the Performance entry buffer.

Typing and backspacing use real keyboard events. The reported `paint` interval
runs from keydown through two animation frames; it is a responsiveness proxy,
not a physical input-to-display measurement. Its floor is about two frames.
The editor handle is resolved once so repeated Playwright selector scans of the
large goal grid do not dominate CPU samples. Checkbox/focus timings, idle frames,
renderer script/style/layout work, memory counters and CPU profiles are retained.
Summaries use medians of the per-run medians and p95 values; inspect individual
rounds before treating small frame-timing differences as improvements.

Each intervention is compared with its disabled state on the same page. Matched
revisions also require byte-identical full-page PNGs for every pair. Images and
CPU samples are explicitly written to disk; list-reporter attachments alone do
not survive successful Playwright runs. Failed runs retain logs and error contexts.

## Retained optimization

The shared text conversion functions skip detached DOM parsing only when input
contains no markup, entities, NUL or carriage returns. Quotes and angle brackets
are escaped as before, raw trailing newlines are removed as before, and HTML
continues through the existing sanitizer. The no-document paths are unchanged.
Generated browser equivalence tests cover parser normalization, escaping, Unicode
and line endings in desktop/mobile Chromium and WebKit.

The final comparison starts from `3ab8f90`, which already contains the original
XP/Vista visual-style bitmaps and pre-blurred Vista wallpaper. Earlier exploration
on `0f74bbd` is not evidence about the replacement artwork. The text optimization
does not change themes, fonts, palettes, assets or Goal Rhythm containment.

## Results on the current artwork

The [five-round matched comparison](https://github.com/jonahclarsen/Balance/actions/runs/42111699197)
uses `3ab8f90` as its baseline. These are Linux medians under 6× CPU slowdown:

| Theme | Standard startup before | After | Reduction |
| --- | ---: | ---: | ---: |
| Mac System 1 | 2,692 ms | 1,482 ms | 45% |
| Windows XP | 4,716 ms | 2,460 ms | 48% |
| Windows Vista | 2,922 ms | 1,634 ms | 44% |
| Graphite control | 2,670 ms | 1,387 ms | 48% |

All twenty standard-workload screenshot pairs are identical. Median typing
remains near 30 ms and checkbox response near 33 ms; this is primarily a loading
improvement, not a claim of faster steady-state frame delivery. Small differences
in frame quantiles should be treated as sampling noise, not as wins.
