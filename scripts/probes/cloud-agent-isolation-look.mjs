/**
 * 云端 Agent 隔离验收里「看画面」的一组(V0～V3),由 `cloud-agent-isolation-probe.mjs` 调(契约 `docs/plan/cloud-agent-contract.md` 第 9.8 节;
 * `docs/plan/hosted-render-contract.md` 第 8a 节)。越权探测的办法、只用假凭证与探针自己的临时目录,不连任何远端。
 *
 * 这一组自己起、自己停同机的渲染服务(`server/hosted-render/main.mjs`:管理进程 + 常驻工作进程 + 它的 Chrome)。Agent 服务由调用方起,
 * 环境里已经带着 `PROMPTCUT_AGENT_LOOK_URL`(指到这里起的管理进程的口子)。两个项目的画面一眼分得开:项目一有一块绿色的方块
 * (内置探针卡 `r6-stateful`),项目二有一块紫色的方块(`r6-unknown`)。模型看到的画面从 Agent 服务的模型历史里取回(探针的临时目录)。
 *
 *   V0 渲染服务起来,看画面开着,登记表里有 agent 的公钥;Agent 服务报 look。
 *   V1 甲项目的对话要不到乙项目的画面:甲的模型 `see_frames` 拿到的是项目一的画面(绿,没有紫);拿项目二的片段 id 去看、去量,
 *      回「没有这个片段」;在参数里塞项目二的 id 与内容不被采信(拿到的还是项目一的画面);渲染服务这段时间收到的看画面请求全是项目一的。
 *      反过来乙的对话拿到的是项目二的(紫,没有绿)。
 *   V2 伪造身份要不到:成员绕过 Agent 服务直接找渲染服务的口子——不带签名、拿自己的委托票据当凭证、自己造一把密钥冒称 agent、
 *      拿渲染服务自己的私钥签、签名对但换了请求体——全 401;浏览器形状的 403;没有一帧多出来。Agent 服务对成员没有任何取画面的接口。
 *   V3 开关关掉后要不到,三层各验一次:
 *      a 项目创建者关掉「渲染节点」→ 甲的 `see_frames` 回「这次没看成」(原因是渲染节点关着)、没有画面;打开后又看得到;
 *      b 项目创建者关掉「云端 Agent」→ 甲拿不到委托(文档服务回 `service-disabled`),消息发不出去(401);即使有人绕过 Agent 服务、拿 agent 的私钥直接向渲染服务要这个项目的画面,
 *        渲染服务也回「云端 Agent 关着」(探针拿 agent 的私钥扮演这一次);打开后恢复;
 *      c 托管方把渲染服务的看画面整个关掉(`PROMPTCUT_RENDER_LOOK=off`,重起渲染服务)→ 甲的 `see_frames` 回「这次没看成」、没有画面;
 *        直接要也回 404。渲染服务停掉之后同样是「这次没看成」,这一轮照常结束。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import { readServiceKeyFile, generateServiceKeyPair, newInstanceId } from '../../server/auth/service-identity.mjs';
import { signLookRequest, LOOK_AUTH_HEADER } from '../../server/hosted-render/look.mjs';
import { ROOT, sleep, waitFor, portBusy, killTree, startProcess, adminOp, mockScript, delegationOf } from './cloud-agent-probe-lib.mjs';

const { PNG } = createRequire(import.meta.url)('pngjs');

/** 两个项目各加的一条轨:画面一眼分得开(项目一绿、项目二紫)。片段 id 带项目的标记 */
export function lookTrack(tag) {
  return { id: 't-look', name: '看画面', clips: [{ id: `clip-${tag}-look`, kind: 'card', cardId: tag === 'one' ? 'r6-stateful' : 'r6-unknown', start: 0, end: 4, params: {} }] };
}

function colors(png) {
  let green = 0; let purple = 0;
  for (let i = 0; i < png.data.length; i += 4) {
    const r = png.data[i]; const g = png.data[i + 1]; const b = png.data[i + 2];
    if (r < 70 && g > 110 && g < 200 && b > 60 && b < 150 && g - r > 60 && g - b > 20) green += 1;
    else if (r - g > 40 && b - g > 40) purple += 1;
  }
  return { green, purple };
}

/**
 * @param {object} o
 * @param {string} o.tmp 探针的临时目录
 * @param {string} o.hostedData 托管组合的数据目录(登记表在它的 secrets/ 下)
 * @param {string} o.base 文档服务的 ws 地址
 * @param {string} o.agentUrl Agent 服务的地址
 * @param {string} o.agentData @param {string} o.agentSecrets
 * @param {number} o.renderPort 渲染服务的端口段起点(+0/+1/+2 常驻、+3/+4/+5 隔离、+6 管理进程)
 * @param {{ p1, p2 }} o.projects @param {{ jia, yi, owner1 }} o.pages @param {{ jia, yi }} o.apis
 * @param {(name: string, ok: boolean, detail?: object) => boolean} o.check
 */
export async function runLookIsolation({ tmp, hostedData, base, agentUrl, agentData, agentSecrets, renderPort, projects, pages, apis, check }) {
  const { p1, p2 } = projects;
  const STATUS = `http://127.0.0.1:${renderPort + 6}`;
  const renderSecrets = path.join(tmp, 'render-secrets');
  const renderData = path.join(tmp, 'render');
  for (const d of [0, 1, 2, 3, 4, 5, 6]) if (await portBusy(renderPort + d)) throw new Error(`端口 ${renderPort + d}(渲染服务)已被占用`);
  runKeygen(['--hosted-data', hostedData, '--secrets', renderSecrets, '--instance-name', '托管方的渲染节点(隔离探针)']);
  let render = null;
  const startRender = (extra = {}) => {
    const env = {};
    for (const k of Object.keys(process.env)) if (/^PROMPTCUT_RENDER_/.test(k) && k !== 'PROMPTCUT_RENDER_SKIP_CHECKS') env[k] = undefined;
    render = startProcess(path.join(ROOT, 'server', 'hosted-render', 'main.mjs'), {
      ipc: true,
      env: {
        ...env,
        PROMPTCUT_RENDER_DOC_URL: base, PROMPTCUT_RENDER_SECRETS: renderSecrets, PROMPTCUT_RENDER_DATA: renderData,
        PROMPTCUT_RENDER_PORT: String(renderPort), PROMPTCUT_RENDER_ISO_PORT: String(renderPort + 3), PROMPTCUT_RENDER_STATUS_PORT: String(renderPort + 6),
        PROMPTCUT_RENDER_MAX_CONCURRENT: '2', PROMPTCUT_RENDER_SAMPLE_MS: '2000', PROMPTCUT_RENDER_MEM_LOW: '256M',
        PROMPTCUT_RENDER_EDITOR_DIR: path.join(tmp, 'no-editor'),
        PROMPTCUT_RENDER_LOOK_SERVICES: path.join(hostedData, 'secrets', 'services.json'),
        ...(process.platform === 'win32' && !process.env.PROMPTCUT_TEST_ENV_FINGERPRINT ? { PROMPTCUT_TEST_ENV_FINGERPRINT: '7e57c10d00000002' } : {}),
        ...extra,
      },
    });
  };
  const stopRender = async () => { const r = render; render = null; if (r) { await r.stop(30_000); killTree(r.child.pid); } };
  const status = async () => (await fetch(`${STATUS}/status`, { signal: AbortSignal.timeout(5000) })).json();
  const ready = () => waitFor(async () => { const s = await status(); return s.directory?.connected && s.worker?.ready && s.queue ? s : null; }, 300_000, '渲染服务就绪', 1000);
  const lookLines = () => (render?.logs ?? []).filter((l) => l.event === 'look.done');

  /** 这个对话交给模型的图片(按先后)与工具结果 */
  const outputOf = (projectId, conversationId) => {
    const stack = [path.join(agentData, 'tenants', projectId)];
    let dir = null;
    while (stack.length && !dir) {
      const at = stack.pop();
      if (!fs.existsSync(at)) continue;
      for (const item of fs.readdirSync(at, { withFileTypes: true })) {
        if (!item.isDirectory()) continue;
        const p = path.join(at, item.name);
        if (item.name === conversationId && fs.existsSync(path.join(p, 'meta.json'))) { dir = p; break; }
        stack.push(p);
      }
    }
    if (!dir) return { images: [], tools: [] };
    const images = [];
    try {
      for (const m of JSON.parse(fs.readFileSync(path.join(dir, 'history.json'), 'utf8'))) for (const b of Array.isArray(m?.content) ? m.content : []) if (b?.type === 'image' && typeof b.data === 'string') images.push(colors(PNG.sync.read(Buffer.from(b.data, 'base64'))));
    } catch { /* 没有历史:按 0 张判 */ }
    const events = fs.existsSync(path.join(dir, 'events.jsonl')) ? fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
    return { images, tools: events.filter((e) => e.type === 'tool_result').map((e) => ({ name: e.name, ok: e.ok === true, summary: String(e.summary ?? '') })) };
  };
  const run = async (api, projectId, conversationId, steps, ms = 240_000) => {
    const sent = await api.send(conversationId, mockScript(steps));
    if (sent.status !== 202) return { sent, images: [], tools: [], state: null };
    const meta = await api.settled(conversationId, ms).catch(() => null);
    await sleep(300);
    return { sent, ...outputOf(projectId, conversationId), state: meta?.state ?? null };
  };
  const see = { tool: 'see_frames', input: { source: 'timeline', t: 1 } };
  const isGreen = (c) => !!c && c.green > 500 && c.purple < 50;
  const isPurple = (c) => !!c && c.purple > 500 && c.green < 50;

  try {
    startRender();
    const st0 = await ready();
    const health = await (await fetch(`${agentUrl}/healthz`)).json();
    check('V0 渲染服务起来,看画面开着,登记表里有 agent 的公钥;Agent 服务报 look', st0.look?.enabled === true && (st0.look?.registry?.agentKeys ?? 0) >= 1 && health.look === true, {
      look: st0.look ? { enabled: st0.look.enabled, agentKeys: st0.look.registry?.agentKeys ?? null } : null, agentLook: health.look ?? null,
    });

    // ---------- V1 甲项目的对话要不到乙项目的画面
    {
      const mark = lookLines().length;
      const a = await run(apis.jia, p1.projectId, 'conv-look-jia', [
        see,
        { tool: 'see_frames', input: { source: 'timeline', clipId: 'clip-two-look' } },
        { tool: 'get_layout', input: { clipId: 'clip-two-look' } },
        { tool: 'see_frames', input: { source: 'timeline', t: 1, projectId: p2.projectId, project: { id: p2.projectId, tracks: [lookTrack('two')] } } },
        { say: '甲看过了' },
      ]);
      const asked = lookLines().slice(mark).map((l) => l.projectId);
      const b = await run(apis.yi, p2.projectId, 'conv-look-yi', [see, { say: '乙看过了' }]);
      const [first, , layout, forged] = a.tools;
      check('V1 甲项目的对话要不到乙项目的画面:拿到的是项目一的(绿);拿项目二的片段 id 去看、去量回「没有」;参数里塞项目二不被采信;渲染服务收到的全是项目一的。乙拿到的是项目二的(紫)',
        a.state === 'idle' && a.images.length === 2 && a.images.every(isGreen) && first?.ok === true && a.tools[1]?.ok === false && /没有 id 为 clip-two-look 的片段/.test(a.tools[1].summary)
        && layout?.ok === false && forged?.ok === true && asked.length >= 2 && asked.every((id) => id === p1.projectId)
        && b.state === 'idle' && b.images.length === 1 && isPurple(b.images[0]), {
          jia: { end: a.state, images: a.images, tools: a.tools.map((t) => `${t.name}:${t.ok ? 'ok' : `不成 ${t.summary.slice(0, 80)}`}`), lookRequestsAllProjectOne: asked.every((id) => id === p1.projectId), lookRequests: asked.length },
          yi: { end: b.state, images: b.images },
        });
    }

    // ---------- V2 伪造身份要不到(成员绕过 Agent 服务直接找渲染服务的口子)
    {
      const served = (await status()).look?.served ?? 0;
      const msg = { projectId: p2.projectId, path: '/api/vision/snapshot', body: { project: { id: p2.projectId, width: 1920, height: 1080, fps: 30, duration: 4, tracks: [lookTrack('two')] }, t: 1 }, timeoutMs: 5000 };
      const text = JSON.stringify(msg);
      const post = async (headers, body = text) => {
        const res = await fetch(`${STATUS}/look`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body, signal: AbortSignal.timeout(20_000) });
        const json = await res.json().catch(() => null);
        return { status: res.status, image: !!json?.__image, says: json?.error ?? null };
      };
      const ticket = (await delegationOf(pages.jia)).ticket;
      const pair = generateServiceKeyPair();
      const selfMade = { service: 'agent', kid: pair.kid, priv: pair.priv, instanceId: newInstanceId() };
      const renderKey = readServiceKeyFile(renderSecrets);
      const agentKey = readServiceKeyFile(agentSecrets);
      const tries = {
        unsigned: await post({}),
        memberTicketAsBearer: await post({ authorization: `Bearer ${ticket}` }),
        memberTicketAsSignature: await post({ [LOOK_AUTH_HEADER]: `v1.${Buffer.from(String(ticket)).toString('base64url')}` }),
        selfMadeKeyAsAgent: await post({ [LOOK_AUTH_HEADER]: signLookRequest(selfMade, text) }),
        renderKey: await post({ [LOOK_AUTH_HEADER]: signLookRequest(renderKey, text) }),
        renderKeyAsAgent: await post({ [LOOK_AUTH_HEADER]: signLookRequest({ ...renderKey, service: 'agent' }, text) }),
        // 截到一份对的签名、换掉请求体(把项目一换成项目二)
        goodSignatureOtherBody: await post({ [LOOK_AUTH_HEADER]: signLookRequest(agentKey, JSON.stringify({ ...msg, projectId: p1.projectId })) }),
        browserShaped: await post({ [LOOK_AUTH_HEADER]: signLookRequest(agentKey, text), 'sec-fetch-site': 'same-site' }),
      };
      // Agent 服务对成员没有任何取画面的接口
      const viaAgent = [];
      for (const p of ['/look', '/v1/look', '/v1/frames', '/v1/conversations/conv-look-yi/frames', '/api/vision/snapshot']) {
        const res = await fetch(`${agentUrl}${p}`, { method: 'POST', headers: { Authorization: `Bearer ${ticket}`, 'Content-Type': 'application/json' }, body: text }).catch(() => null);
        viaAgent.push(res ? res.status : 0);
      }
      const after = (await status()).look?.served ?? 0;
      const statuses = Object.fromEntries(Object.entries(tries).map(([k, v]) => [k, v.status]));
      check('V2 伪造身份要不到:不带签名、拿委托票据当凭证、自己造密钥冒称 agent、拿渲染服务的私钥签、对的签名换了请求体全 401;浏览器形状的 403;一帧都没多出;Agent 服务没有取画面的接口',
        Object.entries(tries).every(([k, v]) => v.status === (k === 'browserShaped' ? 403 : 401) && !v.image) && after === served && viaAgent.every((s) => s === 404), { statuses, served: [served, after], viaAgentService: viaAgent });
    }

    // ---------- V3a 项目的「渲染节点」开关
    {
      const off = await adminOp(pages.owner1, p1, 'set-hosted-service', { service: 'render', enabled: false });
      await waitFor(async () => (await status()).directory?.list?.find((p) => p.projectId === p1.projectId)?.enabled === false, 15_000, '渲染服务看到开关关了').catch(() => null);
      const a = await run(apis.jia, p1.projectId, 'conv-look-off-a', [see, { say: '关着的时候看了一次' }], 120_000);
      const on = await adminOp(pages.owner1, p1, 'set-hosted-service', { service: 'render', enabled: true });
      await waitFor(async () => (await status()).directory?.list?.find((p) => p.projectId === p1.projectId)?.enabled === true, 15_000, '渲染服务看到开关开了').catch(() => null);
      const b = await run(apis.jia, p1.projectId, 'conv-look-on-a', [see, { say: '打开后又看了一次' }]);
      check('V3a 项目创建者关掉「渲染节点」后要不到画面(回「这次没看成」,这一轮照常结束);打开后又看得到', off.type === 'shared.admin.ok' && on.type === 'shared.admin.ok'
        && a.state === 'idle' && a.images.length === 0 && a.tools[0]?.ok === false && /这次没看成.*渲染节点/.test(a.tools[0].summary) && b.images.length === 1 && isGreen(b.images[0]), {
        whileOff: a.tools[0] ? { ok: a.tools[0].ok, says: a.tools[0].summary.slice(0, 120) } : null, end: a.state, images: a.images.length, afterOn: b.images,
      });
    }

    // ---------- V3b 项目的「云端 Agent」开关
    {
      const off = await adminOp(pages.owner1, p1, 'set-hosted-service', { service: 'agent', enabled: false });
      await waitFor(async () => (await status()).directory?.list?.find((p) => p.projectId === p1.projectId)?.hosted?.agent?.enabled === false, 15_000, '渲染服务看到云端 Agent 关了').catch(() => null);
      // 开关关着:成员连委托都要不到(文档服务回 service-disabled),消息发不出去
      const grant = await delegationOf(pages.jia);
      const sent = await apis.jia.send('conv-look-off-b', mockScript([see, { say: '发不出去' }]));
      // 有人绕过 Agent 服务、拿 agent 的私钥直接要这个项目的画面(探针扮演这一次):渲染服务自己也看开关
      const msg = JSON.stringify({ projectId: p1.projectId, path: '/api/vision/snapshot', body: { project: { id: p1.projectId, width: 1920, height: 1080, fps: 30, duration: 4, tracks: [lookTrack('one')] }, t: 1 }, timeoutMs: 5000 });
      const res = await fetch(`${STATUS}/look`, { method: 'POST', headers: { 'content-type': 'application/json', [LOOK_AUTH_HEADER]: signLookRequest(readServiceKeyFile(agentSecrets), msg) }, body: msg, signal: AbortSignal.timeout(20_000) });
      const direct = { status: res.status, ...(await res.json().catch(() => ({}))) };
      const on = await adminOp(pages.owner1, p1, 'set-hosted-service', { service: 'agent', enabled: true });
      await waitFor(async () => (await status()).directory?.list?.find((p) => p.projectId === p1.projectId)?.hosted?.agent?.enabled === true, 15_000, '渲染服务看到云端 Agent 开了').catch(() => null);
      await waitFor(async () => (await apis.jia.info()).enabled === true, 15_000, 'Agent 服务看到开关开了').catch(() => null);
      const b = await run(apis.jia, p1.projectId, 'conv-look-on-b', [see, { say: '打开后又看了一次' }]);
      check('V3b 项目创建者关掉「云端 Agent」后要不到画面:成员拿不到委托、消息发不出去;绕过 Agent 服务直接要,渲染服务也回「云端 Agent 关着」;打开后恢复', off.type === 'shared.admin.ok' && on.type === 'shared.admin.ok'
        && grant.ticket === null && grant.reason === 'service-disabled' && (sent.status === 401 || sent.status === 403) && direct.status === 403 && direct.look === 'agent-disabled' && !direct.__image && b.images.length === 1 && isGreen(b.images[0]), {
        delegation: grant.ticket === null ? `要不到(${grant.reason})` : '要到了', send: { status: sent.status, code: sent.code ?? null }, directToRender: { status: direct.status, look: direct.look ?? null }, afterOn: b.images,
      });
    }

    // ---------- V3c 托管方把渲染服务的看画面整个关掉;再把渲染服务停掉
    {
      await stopRender();
      startRender({ PROMPTCUT_RENDER_LOOK: 'off' });
      const st = await ready();
      const a = await run(apis.jia, p1.projectId, 'conv-look-off-c', [see, { say: '整个关着的时候看了一次' }], 120_000);
      const msg = JSON.stringify({ projectId: p1.projectId, path: '/api/vision/snapshot', body: { project: { id: p1.projectId, tracks: [] }, t: 1 }, timeoutMs: 5000 });
      const direct = await fetch(`${STATUS}/look`, { method: 'POST', headers: { 'content-type': 'application/json', [LOOK_AUTH_HEADER]: signLookRequest(readServiceKeyFile(agentSecrets), msg) }, body: msg, signal: AbortSignal.timeout(20_000) }).then((r) => r.status).catch(() => 0);
      await stopRender();
      const b = await run(apis.jia, p1.projectId, 'conv-look-down', [see, { say: '渲染服务停着的时候看了一次' }], 120_000);
      check('V3c 托管方关掉渲染服务的看画面(PROMPTCUT_RENDER_LOOK=off)后要不到画面;渲染服务停着时同样是「这次没看成」,两轮都照常结束', st.look?.enabled === false && direct === 404
        && a.state === 'idle' && a.images.length === 0 && a.tools[0]?.ok === false && /这次没看成/.test(a.tools[0].summary)
        && b.state === 'idle' && b.images.length === 0 && b.tools[0]?.ok === false && /这次没看成/.test(b.tools[0].summary), {
        lookEnabled: st.look?.enabled ?? null, directToRender: direct,
        whileOff: a.tools[0] ? { ok: a.tools[0].ok, says: a.tools[0].summary.slice(0, 100) } : null,
        whileDown: b.tools[0] ? { ok: b.tools[0].ok, says: b.tools[0].summary.slice(0, 100) } : null,
      });
    }
  } finally {
    await stopRender().catch(() => {});
    const left = [];
    for (const d of [0, 1, 2, 3, 4, 5, 6]) if (await portBusy(renderPort + d)) left.push(renderPort + d);
    if (left.length) check('V 收尾:渲染服务的端口都放开了', false, { stillBusy: left });
  }
}
