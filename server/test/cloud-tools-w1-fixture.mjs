// W1(云端网页操作)测试夹具:真 SQLite 运行授权 + 真运行资源登记器 + 真出网闸 + 真浏览器(puppeteer 自带的 Chrome for Testing,无头)。
// 不假装的:没有真 mTLS(运行授权经夹具里的受控适配器调真的授权库,同 cloud-tools-p2-fixture.mjs 的做法);没有真模型。
// 一个夹具里有两个项目、每个项目里多个对话,都在同一个文档服务账本里,用来验「项目 × 对话」的隔离。
import fs from 'node:fs';
import path from 'node:path';
import { digestOf } from '../account/ledger.mjs';
import { canonicalReadRecord } from '../account/run-authority.mjs';
import { runFixture, projectId, conversationId, servicePrincipal } from './run-authority-fixture.mjs';
import { createRunResources } from '../agent/service/run-resources.mjs';
import { createEgressGate } from '../agent/service/egress.mjs';
import { createHostedBrowserTools } from '../agent/service/hosted-browser.mjs';

export { projectId, conversationId };
export const otherProjectId = 'sp_other';
export const secondConversationId = 'conversation_second';
/** 启动参数打头的那一个,同 `scripts/probes/probe-chrome.mjs` 的 `PROBE_CHROME_ARGS`(server/ 不引 scripts/,所以抄在这里;探针传的是原件) */
export const TEST_CHROME_ARG_PREFIX = Object.freeze(['--disable-field-trial-config']);

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (err) { return err?.code === 'EPERM'; } };
export async function until(check, { ms = 15_000, step = 50, what = 'condition' } = {}) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(step);
  }
}

/** 测试用的解析函数:只认 localhost,别的一律解析不了 */
export async function hermeticResolve(hostname) {
  if (hostname === 'localhost') return [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }];
  throw Object.assign(new Error('ENOTFOUND'), { code: 'ENOTFOUND' });
}

let chromePathPromise = null;
/** 本机测试用的浏览器:puppeteer 自带的 Chrome for Testing。没有就抛(测试不跳过) */
export function testChromePath() {
  chromePathPromise ??= (async () => {
    const puppeteer = (await import('puppeteer')).default;
    const file = await puppeteer.executablePath();
    if (!file || !fs.existsSync(file)) throw new Error(`puppeteer 自带的 Chrome for Testing 不在:${file}`);
    return file;
  })();
  return chromePathPromise;
}

/** 同版本的 chrome-headless-shell(节点上装的是它);本机没有就回 null */
export async function testHeadlessShellPath() {
  const chrome = await testChromePath();
  // …/puppeteer/chrome/win64-152.x/chrome-win64/chrome.exe → …/puppeteer/chrome-headless-shell/win64-152.x/chrome-headless-shell-win64/chrome-headless-shell.exe
  const build = path.basename(path.dirname(path.dirname(chrome)));
  const platformDir = path.basename(path.dirname(chrome)).replace(/^chrome-/, 'chrome-headless-shell-');
  const cache = path.dirname(path.dirname(path.dirname(path.dirname(chrome))));
  const exe = path.join(cache, 'chrome-headless-shell', build, platformDir, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
  return fs.existsSync(exe) ? exe : null;
}

/**
 * @param {import('node:test').TestContext} t
 * @param {object} [options]
 * @param {string[]} [options.testAllow] 出网闸的测试例外(「IP:端口」)
 * @param {Function} [options.resolve] 出网闸的解析函数(模拟 DNS)
 * @param {object} [options.limits] 覆盖 HOSTED_BROWSER_DEFAULTS
 * @param {object} [options.runtime] 覆盖 runtime(如 `{ executablePath: null }` 模拟没配浏览器)
 */
export async function w1Fixture(t, options = {}) {
  const authority = await runFixture();
  // 再加一个对话、一个项目(同一个账本)
  authority.ledger.transaction((s) => {
    const conv = (p, id) => ({ v: 2, projectId: p, id, ownerAccountId: 'owner', visibility: 'shared', aclRevision: 1, queueRevision: 1, currentRunId: null, messages: [] });
    s.conversationsV2[projectId][secondConversationId] = conv(projectId, secondConversationId);
    s.projects[otherProjectId] = { projectId: otherProjectId, status: 'active', creatorAccountId: 'owner', hosted: { agent: true }, bans: {},
      members: { owner: { access: 'rw' }, sender: { access: 'rw' }, other: { access: 'rw' } }, accessRevision: 1 };
    s.conversationsV2[otherProjectId] = { [conversationId]: conv(otherProjectId, conversationId) };
  });

  const flags = { readOnly: false, checks: 0 };
  const runClient = {
    registerInstance: async () => authority.agentProcess.registration,
    instanceIdentity: () => authority.agentProcess.registration,
    async checkAccess({ projectId: p, runGrantId, action }) {
      flags.checks += 1;
      if (flags.readOnly && action === 'write') throw Object.assign(new Error('read-only'), { status: 403, code: 'read-only' });
      const principal = await authority.provider.resolveRunPrincipal({ servicePrincipal, projectId: p, runGrantId });
      return authority.provider.checkAccess({ principal, projectId: p, action });
    },
  };
  const resources = createRunResources({ runClient });

  let serial = 0;
  /** 发一条消息、接下这一轮、确认读过 → 这一轮的可信运行上下文 */
  async function newRun({ project = projectId, conversation = conversationId, accountId = 'sender' } = {}) {
    serial += 1;
    const messageId = `message${serial}`;
    authority.ledger.transaction((s) => {
      const c = s.conversationsV2[project][conversation];
      const content = `Full content ${messageId}`;
      c.messages.push({ messageId, requestId: `send-${messageId}`, arrivalSeq: c.messages.length + 1,
        senderAccountId: accountId, senderNameAtSend: `${accountId} name`, loginId: `login-${accountId}`,
        credentialId: `credential-${accountId}`, loginGeneration: 1, content, contentDigest: digestOf(content), attachments: [],
        selectionSnapshot: { projectId: project, accountId, pageId: 'page1', selection: { clipIds: [] }, sentAt: authority.clock.now, source: 'sent-snapshot' },
        queueState: 'queued' });
    });
    const grant = await authority.provider.admit({ servicePrincipal, projectId: project, conversationId: conversation, requestId: `admit-${serial}` });
    const prompt = canonicalReadRecord(grant.message, grant);
    await authority.provider.confirmRead({ servicePrincipal, projectId: project, conversationId: conversation, messageId: grant.messageId, runId: grant.runId,
      runGrantId: grant.runGrantId, requestId: `read-${serial}`, readIntentId: `intent-${serial}`, prompt, promptDigest: digestOf(prompt) });
    const context = await resources.contextFor({ projectId: project, runGrantId: grant.runGrantId });
    return { grant, context };
  }

  /** 对话设为私有(账本里的真动作):当前这一轮的授权被收回 */
  function makePrivate({ project = projectId, conversation = conversationId, requestId = `private-${serial}` } = {}) {
    return authority.ledger.transaction((s) => authority.hooks.privateFenceInState(s, { projectId: project, conversationId: conversation, ownerAccountId: 'owner',
      requestId, runHooks: authority.provider.hooks }));
  }

  const egressLog = [];
  const gate = createEgressGate({
    testAllow: options.testAllow ?? [],
    // 缺省的解析函数一个名字都不认:测试不连公网(Chrome for Testing 起来时自己会去连几个谷歌的地址,在代理那里就被拒)
    resolve: options.resolve ?? hermeticResolve,
    log: (event, fields) => egressLog.push({ event, ...fields }),
  });
  const serviceLog = [];
  const dataDir = path.join(authority.dir, 'agent');
  const executablePath = options.runtime && Object.hasOwn(options.runtime, 'executablePath') ? options.runtime.executablePath : await testChromePath();
  const opened = [];
  const openTools = (overrides = {}) => {
    const tools = createHostedBrowserTools({
      resources, egress: gate, dataDir,
      runtime: { argPrefix: [...TEST_CHROME_ARG_PREFIX], ...options.runtime, executablePath, ...overrides.runtime },
      limits: { ...options.limits, ...overrides.limits },
      log: (event, fields) => serviceLog.push({ event, ...fields }),
    });
    opened.push(tools);
    return tools;
  };
  const tools = openTools();

  t.after(async () => {
    for (const each of opened) { try { await each.close('test-end'); } catch { /* 下面照样清 */ } }
    try { await resources.close(); } catch { /* 已经关了 */ }
    authority.close();
    for (let i = 0; i < 20; i += 1) {
      try { fs.rmSync(authority.dir, { recursive: true, force: true }); } catch { /* 浏览器刚退,句柄还没放 */ }
      if (!fs.existsSync(authority.dir)) break;
      await sleep(200);
    }
  });

  return { authority, resources, runClient, flags, gate, egressLog, serviceLog, dataDir, tools, openTools, newRun, makePrivate, executablePath };
}

/** 清单里按名字找一项(找不到就抛,带上清单方便看) */
export function item(view, name) {
  const found = (view.clickable ?? []).find((c) => c.n === name) ?? (view.clickable ?? []).find((c) => c.n.includes(name));
  if (!found) throw new Error(`清单里没有「${name}」:${JSON.stringify((view.clickable ?? []).map((c) => `${c.u}=${c.n}`))}`);
  return found;
}

/** 把截图存下来(测试取证用;目录由调用方给) */
export function saveShot(view, file) {
  if (!view?.__image?.base64) throw new Error('这个结果里没有图');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.from(view.__image.base64, 'base64'));
  return file;
}
