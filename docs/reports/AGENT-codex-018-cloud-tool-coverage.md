# Cloud Agent tool coverage inventory

- Worktree: `PromptCut/.worktrees/018-cloud-tool-coverage`
- Branch: `codex/018-cloud-tool-coverage`
- Fixed starting revision: `8b255ab4d0f261415664c3822aff25ad24ac1e79`
- Scope: only `docs/plan/cloud-agent-tool-coverage.md` and this report. This is a static source and contract inventory for the remaining Cloud Agent tools; no implementation, production route/store, service, probe, test, install, node, main, or push changes are authorized.
- Read the repository entry rules and shared developer guidance before starting. The source of product decisions is the current cloud-agent task and contract plus the account-binding decisions, with the latest user decisions taking precedence over historical handoff notes and old fixtures.
- Planned inventory: for each remaining tool, record its exact name, hosted route/entry and line, reusable implementation, directly relevant test/probe, what that evidence actually covers, production-unverified boundary, and required dependency (instance grant, materials, initiator selection, local download, rendering, or separate tool service). Mark user-decided exclusions/replacements separately from implementation gaps; do not treat old fixtures or prior full-suite results as proof of current production coverage.
- Initial repository state was clean at the fixed revision. No service, probe, test, or install has been run for this task.
