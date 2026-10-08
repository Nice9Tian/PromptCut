# Cloud Agent policy and acceptance port alignment

- Worktree: `PromptCut/.worktrees/018-cloud-policy-alignment`
- Branch: `codex/018-cloud-policy-alignment`
- Fixed starting revision: `bb0266fafe5f66e27d8c53000b2340f10f139780`
- Scope authorized: `server/agent/service/cloud-tools.mjs` (spawn_agent policy only), new `server/test/cloud-agent-spawn-disabled.test.mjs`, `scripts/acceptance/acceptance-lib.mjs` (port shifting only), necessary acceptance port-scope test(s), `docs/plan/cloud-agent-tool-coverage.md` (get_selection and spawn rows only), and this report. No other source, semantics, UI, deployment, service, probe, full test run, node, main, or push changes.
- Read the repository guide and required behavior/constraints, the specified three-version brief sections 5/8/9/11, the current Agent/account decisions and semantics, the cloud Agent contract supplement, and the relevant acceptance manifest and port-shifting code.
- Work item A: ensure a hosted `spawn_agent` call is removed from the model tool list and always returns the exact user-approved message `云端暂不支持开子 Agent`, online or offline, without creating a conversation/process or invoking `pageCall`; leave local/LAN spawn unchanged.
- Work item B: preserve ports self-reserved in acceptance probe manifests (multi-agent 5840–5859; skill-mcp 5880–5899) under `--port-shift`, while continuing to shift ordinary 5xxx port arguments and leave 8xxx service ports alone. Add tests against both actual manifest command shapes; do not relax probe port validation.
- The existing root baseline is running on a shared session. This leaf will not run service-based probes or the full suite. Any necessary runtime verification must bind OS-selected port 0; run only focused tests and type checking within the stated limits, preserving failures and reporting unverified boundaries.
- Initial tree was clean at the fixed revision; no services or tests have been started by this work.
