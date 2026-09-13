# Card runtime protocol v1

This is the shared internal protocol for the Python and Chrome adapters, not a replacement authoring API. The author writes `class ExampleCard`, `__init__(style=None)` and `card(source, time)`. Audio uses the same entry point with a block-capable source.

## Definitions, nodes and values

A definition has `id`, `language` (`python`, `tsx`, `builtin`), `entry` (Python class name), `source` (text), `kind` (`animation`, `filter`, `transition`, `emphasis`, `audio`), `defaults`, `need_prerendering`, `compositing` (`independent`, `context`, `unknown`), and `styleKeys` (null means all style; [] means none; array means selected top-level keys). Python defaults conservatively consume all style; authors may declare narrower use. The definition is saved with the project. Runtime/library ABI versions are included in cache identity.

A graph has `nodes` and `outputs`. Each node has a unique `id`, an internal `adapter`, an optional `definitionId`, immutable `params`, and named `inputs`. Each input reference has `nodeId`, `offset` (seconds, default 0), and `rate` (default 1): input time = requested local time * rate + offset. Graph validation rejects cycles and missing references. Placement is outside node evaluation: clip local time = timeline time - clip.start, with source offsets described by input references. Cache sampling records fractional frame phase and exact audio sample indices.

Values are tagged descriptions: `source` (node/time), `glsl` (source text, input values, uniforms), `pixels` (binary file descriptor, width/height/stride/format), `audio` (binary file descriptor, sampleRate/channels/startSample/frames), or `draw` (typed drawing commands). Pixel buffers use RGBA8 straight alpha; audio buffers use interleaved little-endian float32. No full image/audio payload is encoded as JSON/base64. All returned paths are relative to a host-created task output directory and are validated before opening; inputs are read-only. Intermediate shader results remain GPU textures in a chain of framebuffer passes.

## Worker transport

Rust receives and emits one JSON object per line over stdin/stdout. Diagnostic output goes to stderr. Requests carry `id`, `op`, `scope`, `revision`, and operation payload. Replies carry matching `id`, `revision`, `ok`, and `result` or structured `error`. Maximum control-message and output-buffer sizes are enforced. Each Python worker belongs to a single immutable authorization scope and is reused within that scope; a worker never accumulates permissions from other projects.

Operations: `inspect` imports and initializes a definition in isolation; `evaluate` runs a graph output at a visual local time or audio sample range; `cancel` cancels a request; `close` disposes the scope. Import and construction never run in the parent process. Python keeps definition modules and instances resident, with graph revision and instance identity defining state lifetime. A stateful instance is advanced in order; backwards access resets/replays or reads a cache.

The worker may request an authorized source value via a correlated `input` event containing node/time or sample range. The trusted source broker supplies a read-only descriptor; it never executes card source. Nested Python nodes can evaluate recursively within one worker without exhausting the worker pool. External media/Chrome nodes are served by host adapters. Cancellation of blocked native Python work terminates that worker and its job; a subsequent request starts a fresh restricted worker.

## GPU registration

`GLSL(text)` returns a callable shader object. Calling it with source values builds a tagged drawing description. Explicit symbolic time/parameter expressions can register a reusable graph; unsupported Python branching or numerical operations do not get translated automatically. Such cards execute Python at the requested time or prerender, according to capability. Shader registration alone is not proof of runtime rendering support; real browser validation is required.

## Publishing and failure

Every task captures an immutable input revision. A completed task may populate its content-addressed cache but must not replace a newer active revision. Missing results are marked incomplete with instance IDs. Editor placeholders never qualify as completed node values and cannot be published into final caches. Export waits for real values or reports an error. Isolation startup failure is a structured error with no unrestricted execution fallback.
