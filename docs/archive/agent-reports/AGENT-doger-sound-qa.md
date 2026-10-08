# Doger sound-effects acceptance verification

## Assignment and boundary

Implement a reproducible Linux Chromium end-to-end sound-effects probe in `scripts/probes/sound-effects-probe.mjs`, test fixtures if necessary, and this report. Production changes belong to the synthesis and integration workers. Work occurs on branch `doger-sound-qa` with QA-owned ports 5250–5259; no user-computer operations, deployment, merge, or push.

## Planned evidence

Verify actual `CardDef.audio` generation, deterministic random access, persistent WAV asset import, ordinary audio clips, seek/replay/mute/gain, existing desktop audio-plan/renderMix/FFmpeg output, browser-export WAV input, final decoded event energy and onset, resource budgets, reopening, and packaging where supported. Save generated projects, samples, MP4, screenshot, and JSON in ignored `work/`.

Windows playback and subjective listening are explicitly untested unless separately observed. Linux measurements do not substitute for the documented laptop performance baseline.

## Initial inspection

Read `AGENTS.md`, developer guide, collaboration/constraints/verification guides, and `draft_sound-effects.md`. The draft alone says not to implement, but this worker is executing the parent's later user-authorized implementation assignment. Existing audio-determinism probe establishes comparison conventions; new production interfaces are pending from sibling workers.

## Implemented acceptance probe

`scripts/probes/sound-effects-probe.mjs` has two explicitly separate lanes:

- Node lane: actual native `CardDef.audio`, shared Unicode event schedule, block determinism, actual generation manager, `createSnapUploader` media chunk/complete requests to actual HTTP asset-service middleware, ordinary clip persistence, actual store splitting, mute/gain plan checks, real `.procp` packaging and restore over HTTP into a second library, resource and cancellation measurements, and existing `buildAudioPlan`/`buildFfmpegArgs` MP4 production with final AAC decode and waveform alignment.
- Browser lane: actual editor generation worker and asset service, seek/replay/pause/mute/gain preview, screenshot, production `renderMix` plus FFmpeg, actual `runBrowserExport` (including its WAV slicing and mixing), decoded MP4 checks, and a fresh browser context loading persisted WAVs. This lane remains unverified in this environment; it does not receive a passing result from the Node lane.

The generated project has a shared-schedule `mu-typing` card and separate persisted keyboard/notification audio clips. The audio clip is split at a nonzero fractional-sample timeline anchor using the actual store action. The Node MP4 uses an explicitly labeled solid-color visual fixture; it is not evidence that the real editor visuals rendered correctly.

## Evidence observed so far

Command: `node scripts/probes/sound-effects-probe.mjs --node-only`.

- 30 checks passed in the recorded run before adding the explicit export-mute assertion.
- PCM partition comparisons at 4096, 7919, and 32767 frames, reversed request order, and nonzero start: maximum relative difference 0 for both presets.
- CJK, punctuation, emoji with skin-tone/ZWJ, spaces, and newline use complete graphemes. The visual and sound events share inclusive timing boundaries. Typing speed regenerates schedule and identity.
- Real asset HTTP service stores two WAVs; repeated generation request joins its existing job. Maximum active generation/upload count is 1. Persisted WAV byte hashes match project references. No audio graph node remains on an ordinary generated clip.
- Real split action preserves a 0.8000208333333334-second media offset. Generated audio plan preserves sample-level timeline coordinates.
- First `.procp` restore landed 2 actual WAV files in a second empty library; subsequent runs correctly deduplicate both.
- Final AAC in the MP4 has all 10 expected event windows with nonzero energy, no nonfinite samples, and peak 0.119846642. A ±1-frame waveform-correlation search against mapped source-WAV PCM found best lag 0 samples for all events; correlation 0.99247–0.999998. This is objective timing/energy evidence, not subjective audio-quality acceptance.
- Maximum 60-second, 10000-event sparse fixture: 11520044 WAV bytes, 2.376 seconds generation, maximum inline block 10.879 ms, process peak RSS approximately 305 MB. These are cloud Node measurements, not browser/laptop performance acceptance.

### Dense-event issue found and addressed by production workers

The originally accepted 10000 simultaneous events with 66-ms tails required 31.68 million voice samples in one block. Measured actual block/event-loop stall: 4055.54 / 4055.79 ms. Reported immediately to the parent and production workers.

The core now rejects more than 64 simultaneous events before allocation; the editor worker runs synthesis off the UI thread. With the accepted 64-voice maximum, measured inline block 34.56 ms, cancellation timer lateness 35.35 ms, and cancel-call-to-terminal-status 0.338 ms. Real browser Worker termination remains untested here.

## Verified browser blockers and scope limits

- `node scripts/probes/sound-effects-probe.mjs --chrome /usr/bin/chromium --no-sandbox --out work/sound-effects/browser-attempt`: Node checks pass, then browser launch fails with `process_singleton_posix.cc:297 socket() failed: Operation not permitted`. Exit status is nonzero; browser checks are not marked passed.
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium node scripts/verify-determinism.mjs --url 'http://127.0.0.1:5250/?export=1'`: exit 1, same mandatory Chromium socket failure.
- `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium PC_FRAME_TEST_URL=http://127.0.0.1:5250 node scripts/verify-unified-frames.mjs`: exit 1, same browser failure.
- Approved execution outside the ordinary socket sandbox produced the same kernel/runtime failure. The official Puppeteer headless-shell installer was attempted three times, including after backoff and with permitted escalation; each attempt failed establishing its configured proxy tunnel. No untrusted binary was substituted.
- The separate cloud-browser route rejected the local QA URL with `ERR_BLOCKED_BY_CLIENT`; that route was not bypassed.
- Windows desktop, real browser preview/worker/renderMix/export, rendered editor screenshots/pixel invariance, cross-browser PCM comparison, laptop performance thresholds, and actual listening are untested.

## Artifacts

Ignored `work/sound-effects/` contains `keyboard.wav`, `notification.wav`, `project.json`, `recipes.json`, `acceptance.procp`, `ffmpeg-acceptance.mp4`, decoded PCM, `report.json`, probe/typecheck/full-test logs, and required visual-probe failure logs. The browser-attempt subdirectory retains the explicit failing full-lane report. Do not present the solid-color MP4 as a rendered visual demo.

## Baseline

Typecheck (`tsc -b --force`) returned zero on the integrated core/flow code. Full `npm test` is running; final result will be appended. Required rendering probes were attempted and blocked as above, so this branch must not be described as full acceptance complete or a green baseline.

## Scope expansion and resource clarification

The parent's later user instruction expands acceptance to audiovisual sound and image on one clip, independent clip mute with a conspicuous timeline indicator, and explicit atomic failure when trying to separate embedded motion-card audio. QA remains open until those interfaces are available and tested where this environment permits.

The 60-second/10000-event measurement above calls the pure WAV renderer directly. It does not prove that a recipe that large can be persisted through the editor/shared-document workflow. The integration now requires separate serialized-recipe and document-diff budgets (parent reports 96 KiB recipe / 224 KiB diff); these limits must be checked independently. Do not describe the pure-render ceiling as the editor's accepted workload.

The first full-suite attempt was externally interrupted: the exec polling tool returned an approval-review cancellation and then `Unknown process id`. The log stops after AP-7 without a root summary; no success or assertion-failure count is assigned to that attempt. A final-scope rerun is pending.

### Additional final-file mix/mute/gain evidence

Latest Node run: 33 checks, zero failures. Three extra final MP4 variants exercise actual export semantics, beyond checking a plan:

- Generated keyboard + notification overlapping an ordinary low-level test-tone WAV: decoded peak 0.127686, finite PCM throughout.
- Independent keyboard clip mute: first-key window RMS falls from 0.0216373 to the remaining ordinary background's 0.00189744.
- Changing generated clip gain from 0.8 to 0.4: final AAC first-event RMS ratio 0.495707.

Artifacts: `overlap-acceptance.mp4`, `muted-acceptance.mp4`, `half-gain-acceptance.mp4`. Their visual stream remains the explicitly labeled color fixture. The ordinary bed is a synthetic test tone, not music or a subjective listening test.

### Actual store-commit coverage

The probe now hands successful real asset uploads to production `actions.commitSoundEffect`, rather than constructing its own ordinary clips. It also uses `actions.setClipVolume` and repeats the actual atomic commit to assert the same clip ID and unchanged project object on retry. Latest Node run: 37 checks, zero failures.

## Audiovisual same-clip acceptance

Run with `node --experimental-transform-types scripts/probes/sound-effects-probe.mjs --node-only --av`. Node needs the transform flag because production `cardAudio.ts` uses a TypeScript constructor parameter property; this does not patch or mock production code.

After integrating the declared-ready AV implementation, 46 checks passed, including:

- Register a test-owned `CardDef` with both a visual Component contract and the actual native keyboard audio function; generate its real graph audio using production `renderEmbeddedCardWav`.
- Upload the resulting WAV to the actual HTTP asset service and attach it with production `commitCardAudio`. One original visual clip remains, with its persisted rendition, rather than creating a second audio clip.
- `buildAudioPlan` selects one persisted WAV and no second generated source. The final MP4 contains all 8 expected keyboard events; peak is 0.150171.
- `separateAudio` returns `EMBEDDED_CARD_AUDIO_UNSEPARABLE` and leaves the exact project object and JSON unchanged.
- `setClipMuted` removes audio from the plan without removing its visual card.
- A real split retains a single 0.8000208333333333-second source offset, without adding both clip and node offsets.
- Changed card parameters and missing WAV assets cause explicit export errors.

The AV project/WAV/MP4 are diagnostic fixtures generated by the probe. Its test-owned visual card is registered by the probe; the Node lane does not render it. Real AV pixels and the timeline mute badge still require a browser screenshot and are untested here. The MP4 visual stream remains the labeled color fixture.

The final-scope typecheck returned zero. The full test suite was restarted after integrating AV/clip-mute/persistence changes; its terminal summary is pending.

## Full-suite result and regression triage

The completed final-scope suite attempt ran 4291 tests in 120.375 seconds: 4192 passed, 92 failed, 7 skipped, 0 cancelled, exit 1. Comparing failing test names against the parent's initial baseline identified exactly four new failures; the other 88 names match the original environment/baseline failures:

1. `typingSourceOffset.test.mjs` expected no sourceOffset field on unrelated cards; the AV integration had broadened the field. Parent has narrowed this behavior to typing/embedded-AV clips and reports the focused test passing.
2. `tool-schema.test.mjs` lacked the new sound tool in its explicit extended-timeout allowlist. Later Agent changes intentionally await sound generation to preserve operation attribution, so the integrated allowlist must reflect that deliberate behavior.
3. `measureGate.test.mjs` imports `onlineCardSources.ts`; a new static dependency evaluated `import.meta.glob` under Node and failed before tests ran. The AV worker owns this regression.
4. The archived multi-agent entrypoint guard matched the English word “orchestration” in a new native sound-card comment. Parent owns the comment correction; the guard must remain strict.

No test was weakened or suppressed by QA. A rerun after the declared-ready fixes is pending. Latest sound acceptance probe run: 47 checks, zero failures, including AV waveform alignment and its volume action. Browser and subjective-listening gaps remain unchanged.
