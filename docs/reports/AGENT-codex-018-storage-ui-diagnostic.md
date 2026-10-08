# Storage UI probe diagnostic instrumentation

- Worktree: `PromptCut/.worktrees/018-storage-ui-diagnostic`
- Branch: `codex/018-storage-ui-diagnostic`
- Fixed starting revision: `80b5e658e0c56a756003a94cab4c5e4992e76fc3`
- Authorized files: `scripts/probes/storage-ui-probe.mjs` and this report only.
- The first diagnostic pass is limited to recording sanitized state around the two U4 menu interactions: button label and expanded state, storage menu item identity/disabled state, bounding box and click point, pathname without query, bounded page errors, and failure screenshots in this probe's own output directory.
- Keep the existing wait, timeout, assertion, physical click, probe behavior, temp fixture isolation, and cleanup behavior unchanged. Do not assume a product defect or change the menu/UI implementation.
- The baseline failure log and screenshot are read-only evidence. No server, browser, probe, renderer, or full suite will be started in this diagnostic leaf. Only static source checks and diff checks are authorized before handing the fixed source to the root for one narrow run.
- Initial worktree was clean at the fixed revision. No probe or service has been started by this work.
