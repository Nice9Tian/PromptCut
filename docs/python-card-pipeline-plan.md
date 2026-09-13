# Unified Python card pipeline implementation record

Authoritative objective (updated by user): `C:/Users/admin/.codex/attachments/ea085f01-dc12-4d55-8c91-1321b148e86a/goal-objective.md`.
The full objective remains the acceptance scope. This record is not a replacement or reduced MVP.

## Initial architecture evidence (before this implementation)

- `server/frame-pipeline.mjs`: separate user/agent/background Chrome lanes; full-scene MOV and indexed PNG frames; sequential HTML snapshots and cumulative-track raster cache. Existing background order is HTML, full MOV, cumulative tracks. It does not satisfy the requested per-instance priority order.
- `src/render/frameMode.mjs`: direct/stateful capability exists. Legacy `react` currently means direct; framework identity alone is insufficient evidence and needs conservative compatibility handling.
- `src/kernel/Stage.tsx`: direct cards receive requested local time while stateful cards replay in the same scene. This retains Chrome stacking/background context.
- `src/editor/preview/UnifiedPreview.tsx`: user playback uses MOV streaming; background preloading currently pauses during playback. Needs nonblocking per-instance missing-result presentation.
- `src/audio/renderMix.ts` and `src/audio/previewAudio.ts`: share Web Audio fxChain. Preserve this as an adapter in the unified graph.
- `server/vite-plugin-cards.ts`, `server/mcp-tools.mjs`, `src/editor/io/procCards.ts`: TSX authoring, editing and project source bundling already exist.
- Bundled Python is `desktop/src-tauri/runtime/python/python.exe`; Cargo is installed. Actual LPAC compatibility is not yet established.

## Architecture v0 (under independent review)

A shared card definition, instance and immutable input-node graph supplies local time, dependencies, style and revisions to all adapters. Python classes implement `card(source, time)` and may return GPU drawing descriptions or pixels/audio blocks. GLSL descriptions registered by Python execute in the browser when their varying inputs can be represented explicitly. Arbitrary Python remains Python, executed only by a sandboxed persistent worker managed by a standalone Rust runner.

Time access and independent caching are separate capabilities. Unknown background requirements retain the complete Chrome scene. Per-instance cache identity includes source, inputs, parameters, used style and local sampling; placement-only changes reuse independent results. Whole-scene identity includes ordering and all scene dependencies. Revisions are immutable and stale tasks may not publish over a newer request.

Reuse FramePipeline, bakery, MOV storage and prerender sidecar. One priority scheduler serves required prerenders, independent control MOVs, then whole-scene MOVs. Foreground work stays independent. Placeholder data is explicitly incomplete and cannot enter final caches or export.

## Requirement audit and planned evidence

All entries start **pending**. An implementation or passing unit test alone is not proof of end-to-end completion.

| Objective | Deliverable | Required authoritative evidence | State |
| --- | --- | --- | --- |
| 1 | Python class, constructor style, immutable source.time, multi-input and audio blocks | Runtime examples with nested time queries, unchanged cursors, two sources, audio buffers | pending |
| 2 | GLSL registration and GPU execution; arbitrary Python algorithms | Real GPU render comparison and instrumented persistent-worker calls; Python image algorithm output | pending |
| 3a | Old-card need_prerendering and real direct/stateful scheduling | Shuffled-time direct React test, sequential-state replay test | pending |
| 3b | Independent control MOVs, local time, alpha, indexing | Decode MOV frames at differing placements, verify alpha composite and local-frame mapping | pending |
| 3c | Context-dependent and unknown Chrome cards preserved | Glass/background scene pixel comparison, no isolated-cache classification without evidence | pending |
| 4a | Required > control MOV > full MOV priorities; cooperative preemption | Runtime trace with new high-priority work arriving during lower-priority tasks | pending |
| 4b | Nonblocking editor bounds and animated hourglass | Browser interaction and playback evidence while required worker is pending | pending |
| 4c | Whole MOV > mixed control caches > direct > state replay | Instrumented see_frames cache-hit/fallback sequence and mixed composition output | pending |
| 4d | Dependency-aware invalidation and stale completion rejection | Source/media/params/style/timeline edits; unchanged controls reused; stale task completion rejected | pending |
| 4e | Incomplete content reported; no placeholders in export/final cache | Pending-card API response and export/final-cache pixel tests | pending |
| 5 | Optional style consumption | None/partial/full style examples and corresponding invalidation | pending |
| 6 | Standalone Rust persistent Python worker pool, DAG, concurrency, cancellation | Real process IDs, parallel independent work, serialized dependencies and cancellation/restart logs | pending |
| 7 | rappct LPAC isolation from import through execution with actual packaged Python | Allowed-read/write and denied-read/write/import probes; fail-closed startup; dependency imports | pending |
| 8 | JSON create/get/edit/apply and project source persistence | Tool calls followed by save/reopen and same rendered result, independent instances | pending |
| 9 | All effect categories and old cards share integration | Animation/filter/transition/emphasis/audio examples in preview, see_frames and final export | pending |
| 9 | Packaging, examples, regression checks and delivery limitations | Build, relevant tests, packaged-runtime smoke, user-visible example project and results report | pending |
| Delivery update | Decoupled commits, installer build, unattended install | Scoped git commits, installer artifact and hash, actual install log/result | pending |
| Delivery update | Real installed application and real project acceptance | Use `C:/Users/admin/Desktop/《九箭旅行社·东京7日深度游》4.proc`; real harness Agent creates/applies custom transition/filter; immediate render and smooth playback evidence | pending |
| Delivery update | Fix and repeat complete release acceptance, maximum five cycles | Numbered cycle records covering commit/build/install/test, observed failures and fixes; never exceed five cycles | pending |

## Work phases

1. Inspect and review architecture; prove bundled Python isolation before importing untrusted code.
2. Implement common graph/capabilities and Python SDK/worker protocol, then Rust pool.
3. Integrate GPU and legacy adapters, cache identity/storage and priority scheduling.
4. Extend authoring, project persistence, editor and audio/visual rendering entrances.
5. Execute all runtime examples and acceptance matrix, fix gaps and document actual limitations.
6. Create scoped commits, build and install unattended, run the complete installed-app/real-project/harness acceptance. Fix and repeat within the user's maximum of five release acceptance cycles. Work on a copy of the real project when modifications are needed, preserving its source.

Release acceptance cycles performed: **1 / 5** (failed; preparing cycle 2). Development unit tests and isolation probes are not release/install cycles.

Independent planning reviews live under `work/agy/python-pipeline-plan/`; isolation investigation under `work/agy/python-isolation/`. These are evidence, not completed product features.

## Development evidence, 2026-09-13

The class/graph SDK, Windows rappct runner, Node broker, browser GPU executor,
visual/audio adapters, project authoring and cache producer have been implemented.
Actual packaged Python 3.11.9 imports NumPy 2.2.6/Pillow 12.3.0 inside LPAC.
Real isolated fixtures prove request cancellation, same-node FIFO broker queries,
two-worker parallel operation, allowed outputs and denied unauthorized filesystem access.

`scripts/verify-card-gpu.mjs` passed real WebGL2 tests for explicit time arithmetic,
shader chains, missing input failures, asymmetric texture orientation and resource disposal.
`scripts/verify-python-cards.mjs` has passed actual HTTP/LPAC GLSL registration,
Pillow output, time intervals, NumPy audio, browser frame capture, source edit/style
refresh, a two-input image transition and Python source-pixel filtering. The expanded
stateful/cache/alpha checks now pass as a complete expanded script, including
upstream GLSL materialized into Python and legacy Chrome sources consumed by
Python. Actual screenshots retain straight alpha [40, 0, 0, 128]. Pending user
frames explicitly identify the unavailable card while Agent frames contain its
real replayed result. Required/control/full-MOV background completion passes.

Legacy direct caption, stateful probe and glass full-scene development captures
pass in `scripts/verify-card-legacy.mjs`. The full suite passed 1,176 tests after
fixing the temporary import paths and archive memory regressions. The final
repeat after instance/source-dependency fixes passes **1,183 / 1,183** tests,
and `tsc -b` passes.
`scripts/verify-card-audio.mjs` verifies actual isolated Python through Chrome's
OfflineAudioContext: exactly 48,000 stereo float samples with values [.25,.75].
`scripts/verify-frame-scene-order.mjs` verifies native/Python/cached control order
and the Python layer's perspective. Eleven Python SDK tests include split-card
state replay and audio time continuity. Scope tests cover bounded admissions,
per-consumer cancellation, failed opens and restart/shutdown races.

All rendering Chrome launches must be offscreen as well as headless: use
`--window-position=-32000,-32000`, and supply negative left/top to headless-shell
`Target.createTarget`; do not bring a window to the user's foreground.

Installed-app/harness cycle **1/5** built commit 4ec8f97, installed the full 0.5.9
installer silently (exit 0), and verified installed runtime file hashes. The real
Harness Agent created and applied Python transition/filter definitions in a copy
of the Tokyo project, but clip-scoped see_frames failed: the old isolation helper
deleted source clips/media. A separate full-project probe found missing optional
style broke runtime identity hashing. A new exact-route development regression
also found post-processing assumed every frame existed in frames/<n>.png, while
the unified pipeline can return it directly from MOV. These are being fixed
before cycle 2; installed acceptance is not yet passing. Evidence is under
work/installed-card-cycle-1. The original project SHA-256 is unchanged.

## Cycle 2 preparation

The exact clip-scoped vision route now preserves graph inputs and consumes the
returned frame bytes regardless of cache tier. Legacy optional style/fps are
normalized before hashing. The full development integration passed again, with
a 24.4s legacy Chrome-to-Python capture; an isolated differential run took 15.7s.
The export network gate now gives visual/source card jobs the runner's 120s
budget while ordinary resources retain 30s and user preview retains its own
10s watchdog. A controlled 35s HTTP response completed with the correct pixels.
This fixes premature timeout classification; it is not a claim that arbitrary
Python or a cold heavy project renders at real time.

The real React lifecycle fixture proves GPU program reuse, cancellation of stale
source work, and preservation of a pending frame ticket while old pixels remain
on the mounted canvas. The unit suite passes 1,186 tests and tsc -b passes.

## Cycle 2 installed result and cycle 3 preparation

Cycle 2 silently installed commit a8aff01 (installer exit 0 and all nine
runtime/source file hashes matched). The real Agent created and applied two
cards, but no effect-after-edit see_frames call succeeded. Its later code
workarounds did not fix the underlying runtime failures; playback measured
zero presented frames. This cycle failed acceptance. Source, tool events,
saved/reopened project, screenshots and original-file integrity evidence are
under work/installed-card-cycle-2; the original SHA-256 remains unchanged.

Two independent installed-environment causes were reproduced:

- NumPy's native thread pools consumed the 512 MiB LPAC commit budget before
  ordinary 1080p arrays could be allocated. The Rust runner now fixes numerical
  thread counts to one. Actual LPAC evaluation with the bundled Python computed
  three 1080p RGBA float32 arrays in 114 MiB private memory, with the job limit
  unchanged and clean open/evaluate/close acknowledgments.
- Chromium launched through a Windows verbatim executable path disabled ANGLE.
  With the same installed binary and identical flags, ordinary paths created
  WebGL2, while the verbatim path returned null. The shell now passes an ordinary
  drive/UNC cache path to Puppeteer. A real installed-binary shader produced
  RGBA [64,128,191,255]. LPAC authorization paths are unchanged.

The acceptance harness now requires a successful frame inspection after the
final card edit/application; a baseline frame taken before adding effects
cannot satisfy the check. Cold sparse playback and complete-cache playback
must be reported separately. Cycle 3 has not yet passed installed acceptance.
