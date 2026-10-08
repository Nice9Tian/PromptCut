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


/** Clicks the real visibility control and waits for a server-derived result on the signed-in page. */
export async function requestAccountVisibility(page, target, { timeoutMs = 30_000 } = {}) {
  if (target !== 'private' && target !== 'shared') throw new Error('visibility-target-must-be-private-or-shared');
  const button = page.locator('[data-pc="cloud-visibility-toggle"]');
  if (!await button.isVisible()) throw new Error('cloud-visibility-control-not-visible');
  const label = await button.innerText();
  if (target === 'private' ? !label.includes('设为私有') && !label.includes('重试设为私有') : !label.includes('设为共有') && !label.includes('重试设为共有'))
    throw new Error(`visibility-control-does-not-target-${target}`);
  await button.click();
  await waitForControlResponse(page, timeoutMs);
  return classifyControlResult(await inspectAccountConversationControls(page), target === 'private' ? '已切为私有。' : '已切为共有。');
}

/** Retries the same visible stop request ID through the real UI; pending remains pending. */
export async function retryAccountStop(page, { timeoutMs = 30_000 } = {}) {
  const button = page.locator('[data-pc="cloud-stop-retry"]');
  if (!await button.isVisible()) throw new Error('cloud-stop-retry-not-visible');
  await button.click();
  await waitForControlResponse(page, timeoutMs);
  return classifyControlResult(await inspectAccountConversationControls(page), '云端已确认停止请求。正在同步对话状态。');
}

async function waitForControlResponse(page, timeoutMs) {
  await page.waitForFunction(() => {
    const status = document.querySelector('[data-pc="cloud-control-status"]')?.textContent?.trim() ?? '';
    return Boolean(status) && !status.startsWith('正在更新') && !status.startsWith('正在向云端提交');
  }, null, { timeout: timeoutMs });
}

function classifyControlResult(state, confirmedText) {
  if (state.status === confirmedText) return { outcome: 'confirmed', state };
  if (state.status?.includes('已禁止新访问，相关服务关闭待确认') || state.status?.includes('云端尚未确认这项操作'))
    return { outcome: 'pending', state };
  return { outcome: 'error', state };
}
