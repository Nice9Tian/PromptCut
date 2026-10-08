# Storage UI probe diagnostic instrumentation

- Worktree: `PromptCut/.worktrees/018-storage-ui-diagnostic`
- Branch: `codex/018-storage-ui-diagnostic`
- Fixed starting revision: `80b5e658e0c56a756003a94cab4c5e4992e76fc3`
- Authorized files: `scripts/probes/storage-ui-probe.mjs` and this report only.
- The first diagnostic pass is limited to recording sanitized state around the two U4 menu interactions: button label and expanded state, storage menu item identity/disabled state, bounding box and click point, pathname without query, bounded page errors, and failure screenshots in this probe's own output directory.
- Keep the existing wait, timeout, assertion, physical click, probe behavior, temp fixture isolation, and cleanup behavior unchanged. Do not assume a product defect or change the menu/UI implementation.
- The baseline failure log and screenshot are read-only evidence. No server, browser, probe, renderer, or full suite will be started in this diagnostic leaf. Only static source checks and diff checks are authorized before handing the fixed source to the root for one narrow run.
- Initial worktree was clean at the fixed revision. No probe or service has been started by this work.

## Baseline evidence and diagnostic changes

- Read-only baseline evidence: `%TEMP%\pc-root-baseline-80b5e658-20261008\logs\P-storage-ui.log`. Its run took about 98 seconds. U1/U2/U3/U7/U8 passed; U4 from the start page passed; the second U4 interaction loaded the editor, waited 1.5 seconds, clicked `.pc-titlebar-menu-button`, then timed out waiting for `[data-pc="titlebar-open-storage"]`. The original run left `items/P-storage-ui/u4-menu-from-start.png`; no editor failure screenshot was present. The root baseline log and screenshot were left untouched.
- Fixed diagnostic source: `7bb223e6d25b7c5bc95344d48ed5e70983f8a7d3` (`Add scoped storage menu probe diagnostics`). It records before/after state for both U4 menu attempts: pathname only, target menu button's bounded label and `aria-expanded`, storage menu item's `data-pc` and disabled state, each target's bounding box, and its center click point with `elementFromPoint` metadata. The click selectors, physical clicks, waits, timeouts, and assertions remain unchanged.
- Page errors are capped at 12 entries and 300 characters each; URLs and common secret-like key/value patterns are redacted. On a U4 exception, the probe records bounded state and a fixture screenshot inside its own `TMP`. Failed runs now retain that TMP; a successful run keeps the existing cleanup. The owned Vite child shutdown waits for the actual child `close` event after a hidden `taskkill` invocation. No UI, product, port selection, or fixture paths were changed.
- Static verification only: `node --check scripts/probes/storage-ui-probe.mjs` exited 0; `git diff --check` exited 0. Static-check logs are `%TEMP%\pc-storage-ui-diagnostic\node-check-final.out.log` and `node-check-final.err.log`.
- No probe, browser, server, renderer, full suite, or type check was run in this leaf. The fixed source is ready for the root's one narrow diagnostic run; whether the menu item is absent, hidden, disabled, or simply missed remains for that run to establish.
