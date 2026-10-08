# Agent work log: ready-index snapshot failure diagnostics

- Worktree: `PromptCut/.worktrees/018-ready-index-diagnostic`
- Branch: `codex/018-ready-index-diagnostic`
- Starting revision: `80b5e658e0c56a756003a94cab4c5e4992e76fc3`
- Scope authorized by coordinator: `scripts/probes/ready-index-probe.mjs` and this report only. No production route/store edits, no probe/server/test execution until separately authorized, no merge/push/main or node operation.
- Read the repository entry rules and shared developer guidance (`AGENTS.md`, `developer_guide.md`, suggested behavior, constraints, verification, and git/release rules). The probe defaults to removing its temporary output directory in `finally`, keeps editor stdout/stderr only in a bounded in-memory ring, and currently records snapshot status/character count/path/equality but not response headers/body or related service errors.
- Existing evidence from coordinator: `pc-root-baseline-80b5e658-20261008/logs/GR-6.log` reports the snapshot GET as HTTP 500, 2,308 response characters, `sameBytes: false`, with 14,413 bytes on disk. The probe's referenced temp export path was already absent when inspected; its server logs did not contain the request key or an exception stack. The production snapshot route is unchanged from main and handles read failure as 404, so this task captures additional evidence only and does not assume a production fix.
- Planned change: when the synthetic probe snapshot response is non-2xx, record a bounded, secret-filtered body plus safe content-type/cache-control and a bounded, filtered service-error excerpt; write this diagnostic record under the probe's temp output directory. Preserve that directory automatically on failure, keep successful default cleanup unchanged, and add `--keep-out` to retain only the current temp output when requested (without leaving the server running). Do not dump environment variables or credentials.
- Initial state: clean at the requested commit. No probe, server, or test has been started by this work.
- Verification and source SHA: pending. Probe execution and any port usage are explicitly deferred until the coordinator grants an exclusive lease.
