/**
 * Browser-page inspection helper for the account cloud conversation controls.
 * A real UI acceptance run needs a root-provided signed-in browser page; this
 * helper does not start a server, browser, or service and never reads credentials.
 */
export async function inspectAccountConversationControls(page) {
  return page.evaluate(() => {
    const panel = document.querySelector('[data-pc="cloud-ai-panel"]');
    if (!panel) throw new Error('cloud-ai-panel-not-mounted');
    const visible = selector => {
      const element = panel.querySelector(selector);
      return Boolean(element && getComputedStyle(element).display !== 'none' && element.getAttribute('aria-hidden') !== 'true');
    };
    return {
      running: panel.getAttribute('data-cloud-running') === '1',
      canStop: panel.getAttribute('data-cloud-can-stop') === '1',
      visibility: panel.querySelector('[data-pc="cloud-conversation-controls"]')?.getAttribute('data-visibility') ?? null,
      canToggleVisibility: visible('[data-pc="cloud-visibility-toggle"]'),
      composerVisible: visible('[data-pc="ai-composer"]'),
      creatorReadOnly: visible('[data-pc="cloud-readonly-note"]'),
      stopVisible: visible('[data-pc="ai-stop"]') || visible('[data-pc="cloud-stop-readonly"]'),
      status: panel.querySelector('[data-pc="cloud-control-status"]')?.textContent?.trim() ?? null,
    };
  });
}

export function assertAccountConversationControls(state, expected) {
  for (const [key, value] of Object.entries(expected)) {
    if (state[key] !== value) throw new Error(`cloud-control-${key}-expected-${String(value)}-got-${String(state[key])}`);
  }
  return state;
}
