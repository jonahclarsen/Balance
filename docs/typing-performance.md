# Typing performance

The matched CI harness is `system-load-profile.yml`. Run it on a branch that
contains the current harness, with `baseline_ref`, `candidate_ref`, the same
theme for both, and `surface=today` or `surface=list-template`. Historical
worktrees receive the same harness. Missing retired dependencies are downloaded
after the required offline install attempt.

For focused frontend validation, check existing `frontend-tests.yml` runs first.
Its concurrency group uses the branch and runner: a focused dispatch with the
same pair can cancel a full run. Wait for it or select a different runner.

Fixtures contain only generated data: 365 days with 20 tasks each, 180 list
runs with 20 tasks each, and 80 goals. The list-template scenario adds a
100-row template and completed runs. A synthetic persistence bridge selects the
native operation queue without opening a database. This deliberately excludes
SQLite, encryption, widgets, sync, and the browser's whole-state snapshot writes.

Each comparison alternates three runs per revision on one runner with two busy
host CPU workers and Chromium 6x CPU throttling. Each run types 24 real `x`
keystrokes and removes them with 24 Backspaces, checking the original text is
restored. Dispatch measures keydown through the input handler; the paint proxy
waits for two animation callbacks. Frame scheduling makes the latter noisy.
CPU samples and raw timings are uploaded with the run.

## October 16, 2026

[Today comparison](https://github.com/jonahclarsen/Balance/actions/runs/38976844359):
October 1 (`015580c`) versus October 16 (`f2f9f62`) did not reproduce a typing
regression. Median typing paint proxies were 21.1 and 18.4 ms respectively.
This small, flat Today fixture does not rule out a different workload regressing.

[Historical list-template comparison](https://github.com/jonahclarsen/Balance/actions/runs/38978371120/job/117233147194)
on one Ubuntu runner likewise did not reproduce a regression: median typing
dispatch was 20.0 ms for `015580c` and 14.8 ms for `f2f9f62`. Compare revisions
within each matched run; absolute timings from different hosts are not comparable.

[September 23 comparison](https://github.com/jonahclarsen/Balance/actions/runs/38980524520/job/117240066073)
on one Ubuntu runner compared `f40d6e9` with `f2f9f62`: typing dispatch was
30.4 -> 14.2 ms and the typing paint proxy 42.1 -> 21.5 ms. This earlier fixture
comparison also did not reproduce the reported regression.

[List-template optimization comparison](https://github.com/jonahclarsen/Balance/actions/runs/38978034695/job/117232069703):
`f2f9f62` versus `bb339fb`, Graphite, macOS 15. Values are the median of three
run medians, in milliseconds.

| Metric | Before | After |
| --- | ---: | ---: |
| Typing dispatch | 7.1 | 4.0 |
| Backspace dispatch | 6.2 | 4.2 |
| Typing paint proxy | 17.8 | 10.0 |
| Backspace paint proxy | 10.1 | 12.6 |

Typing dispatch improved about 44%, and Backspace dispatch about 32%. The
Backspace paint proxy did not improve in this run. The changes reuse unchanged
sibling editor markup, cache historical list timing statistics independently
of template edits, and skip word-cap/inline-code DOM scans when unnecessary.
No persisted formats or editor behavior changed.

[An additional Iridescent comparison](https://github.com/jonahclarsen/Balance/actions/runs/38979034981/job/117235284978)
on one Ubuntu runner measured typing dispatch at 15.8 -> 11.0 ms and Backspace
dispatch at 12.3 -> 8.9 ms. Paint proxies were effectively unchanged (typing
30.2 -> 29.7 ms, Backspace 27.3 -> 27.3 ms). Less editor work does not guarantee
the same improvement in frame latency for every theme and workload.
