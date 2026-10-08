# Cloud Tool Jobs ledger

- Worktree: `PromptCut/.worktrees/018-cloud-tool-jobs`
- Branch: `codex/018-cloud-tool-jobs`
- Fixed starting revision: `e67ca4cffec228fcb031e1e3c797f532631d728a`
- Authorized files: new `server/agent/service/tool-jobs.mjs`, new `server/test/cloud-tool-jobs.test.mjs`, and this report only.
- Implement the F0 `ToolJobs` persistence seam as an isolated SQLite ledger with an explicit private database path and mandatory trusted `authorize(context, action)` and `verifyFence(context, revision)` callbacks. No account ledger, service wiring, provider deployment, process runner, or production route changes.
- Preserve the current account/run authority semantics: current conversation ACL controls reads; job writes bind to the exact run/grant/instance generation; cancellation requires the trusted fence callback and only affects that exact fence; no job record can reauthorize an old run. Restart marks unsafe `running` jobs `interrupted`, leaves queued jobs queued, and does not resume work.
- Persist only validated scope identifiers, request/input digests, safe progress/output references, revision/state, and error codes. Do not persist tokens, model bodies, filesystem paths, or credentials. `close()` closes this ledger only and is not a child-process completion witness.
- No server, fixed port, probe, full suite, install, node, main, or push operation is authorized in this leaf. Use isolated temporary SQLite fixtures and focused tests/type checks; preserve any first failure.
- Initial worktree was clean at the fixed revision. No service or test has been started by this work.
