#!/usr/bin/env node
/**
 * 云端 Agent 的隔离验收探针,对着**真的 Agent 服务进程**(任务书 `docs/plan/cloud-agent-task.md` 完成条件第 4 条,核心项;
 * 契约 `docs/plan/cloud-agent-contract.md` 第 4、7.2 节)。
 *
 * `cloud-agent-auth-probe.mjs` 用一个「假 Agent 服务」验了文档服务一侧;这里验的是整条链:成员的页面 → Agent 服务的 HTTP 接口
 * → 文档服务核验 → 换票据 → 数据连接 → 工具执行 → 改动落地,以及只在 Agent 服务一侧的东西(对话记录、模型历史)。
 *
 * 搭法(全部真进程、真握手,只绑 127.0.0.1,数据在一个临时目录里,结束时删掉):
 *   - 托管组合 `server/hosted/main.mjs`(文档 + 素材),本机信任关着;
 *   - Agent 服务 `server/agent-service/main.mjs`(命令行入口,凭 keygen 生成的服务私钥),模型是模拟模型提供方;
 *   - 两个限定进入的项目:项目一(创建者 owner1,成员 甲 jia、丙 bing、丁 ding〔只读〕、戊 wu、己 ji),
 *     项目二(创建者 owner2,成员 乙 yi、丙 bing)。项目文档里各带一个只属于自己的标记(项目名、片段文案、素材名)。
 *     只读成员没有设置它的界面与操作(契约第 4.6 节),探针停掉托管组合直接写项目记录造出来。
 *
 *   node scripts/probes/cloud-agent-isolation-probe.mjs [--doc-port 8798] [--asset-port 8799] [--agent-port 5741] [--render-port 5820] [--no-look] [--keep]
 *
 * 验收标准(每条一行 JSON,`ok` 全为 true 才算过;退出码 0 过、1 不过、2 起不来):
 *   I1  不带票据、乱写的票据打每个接口:全 401,响应体不说原因。
 *   I2  成员甲的对话读不到成员乙的项目:让模型去读项目二的片段、列素材——工具回找不到;甲的模型历史里有项目一的标记、
 *       没有项目二的任何标记;甲拿不到进项目二的委托。
 *   I3  成员甲的对话改不了成员乙的项目:让模型改项目二的片段——没有落地,项目二的版本与内容不变;同一轮里改项目一的落地了,
 *       写入的署名是甲本人加 `service: 'agent'`。请求体里自报别的项目、别的成员、别的 sessionId 不被采信。
 *   I4  一个项目的对话拿不到另一个项目的对话记录:丙在两个项目里各有一个同名对话,凭项目二的票据列不出、取不到、看不到、
 *       停不了、删不掉项目一的;两边的事件互不出现。同一项目里别的成员(甲)也读不到丙的对话。
 *   I5  一个项目的对话拿不到另一个项目的素材:列素材只回本项目的,Agent 服务没有任何取素材字节的接口(逐个试,全 404)。
 *       素材的写入、别的项目的素材、撤销见下面的 T1 与 auth 探针 P。
 *   T1～T5 工具(任务书 J〔2026-10-07 更正〕并进本条验收的几组,在 `cloud-agent-isolation-tools.mjs`,越权探测的办法、只用假凭证):
 *       T1 素材写入按成员本人的权限(读写成员写得进、只读成员写不进、别的项目的素材读不到);
 *       T2 工具的文件读写按「项目 × 对话」隔离(别的项目、别的对话、Agent 服务的私钥与数据目录、托管服务的数据目录、系统文件);
 *       T3 出网闸(回环、内网、169.254.169.254、同机各服务,含换写法与重定向;测试专用的外部地址能通);
 *       T4 花钱的调用记用量(替身配音服务);T5 建卡改卡(源码经内容库、卡只在本项目里认得、卡片代码不在服务进程里执行)。
 *   V0～V3 看画面(契约第 9.8 节;在 `cloud-agent-isolation-look.mjs`,这一组自己起停同机的渲染服务,`--no-look` 跳过):
 *       V1 甲项目的对话要不到乙项目的画面;V2 伪造身份要不到;V3 开关关掉后要不到(项目的「渲染节点」、项目的「云端 Agent」、托管方的总开关三层)。
 *   I6  伪造的成员身份证明被拒:签名改一个字符、自己造密钥签、拿项目二的密钥签项目一的、把成员改成别人——当委托票据用一律 401;
 *       当对话委托随消息带一律 403 `bad-grant`,不起任何一轮。别的对话的委托、别的成员的委托、短的委托票据冒充对话委托同样被拒。
 *   I7  过期的成员身份证明被拒:过期的委托票据 401;过期的对话委托 403 `bad-grant`。
 *   I8  只读成员发起的对话改不了项目:丁让模型改文案——工具被文档服务拒绝,项目版本不变;读照常。
 *   I9  创建者关掉开关后正在进行的对话被停掉:甲的对话正在连续写入(甲的页面连接此时已全部断开——成员不在线),
 *       创建者关开关 → 2 秒内事件流收到 `error { code: 'revoked', reason: 'disabled' }` 与 `end`,对话记录里留下原因;
 *       之后没有新的写入;再发消息回 403 `disabled`;同一时刻丙在项目二的对话照常跑完(只停这个项目的)。开回来后恢复。
 *   I10 成员被移出名单:戊正在进行的对话 2 秒内停下,原因 `removed`;他之后拿不到委托,读不到自己的对话。
 *   I11 成员被踢:己正在进行的对话 2 秒内停下,原因 `kicked`。
 *   I12 项目删除:丙在项目二正在进行的对话 2 秒内停下;Agent 服务删掉这个项目的对话记录与模型历史(用量记录留着)。
 *   I13 委托票据、对话委托、连接票据的原文不落盘、不进日志:Agent 服务的数据目录与日志全文里一条都没有。
 *   I14 节点资源:同一位成员同时进行的一轮不超过上限(2),第三条回 429 `busy`;结束后名额释放。
 *       进程带着 `--max-old-space-size=1536` 起来,报的堆上限与它相符。
 * 最后一行是汇总 `{ ok, passed, failed, revokeMs }`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { createSharedProject } from '../../server/auth/client.mjs';
import { signDelegation } from '../../server/auth/delegation.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import {
  KDF, sleep, waitFor, portBusy, startHosted, startAgent, joinAs, adminOp, projectOf, putProject, mockScript, delegationOf, agentApi, createChecks, readTree,
} from './cloud-agent-probe-lib.mjs';
import { prepareToolFixtures, runToolIsolation } from './cloud-agent-isolation-tools.mjs';
import { runLookIsolation, lookTrack } from './cloud-agent-isolation-look.mjs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const DOC_PORT = Number(argOf('--doc-port', 8798));
const ASSET_PORT = Number(argOf('--asset-port', 8799));
const AGENT_PORT = Number(argOf('--agent-port', 5741));
const KEEP = args.includes('--keep');
/** 看画面那一组起的渲染服务:+0/+1/+2 常驻工作进程、+3/+4/+5 隔离工作进程、+6 管理进程(看画面的口子在它上面) */
const RENDER_PORT = Number(argOf('--render-port', 5820));
const LOOK = !args.includes('--no-look');
/** 探针自己在本机回环上起的三个替身:测试专用的外部地址(收集站)、替身配音服务、同机的「别的服务」 */
const COLLECTOR_PORT = Number(argOf('--collector-port', 5745));
const VOICE_PORT = Number(argOf('--voice-port', 5746));
const DECOY_PORT = Number(argOf('--decoy-port', 5749));
const BASE = `ws://127.0.0.1:${DOC_PORT}`;

const { results, check } = createChecks();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-iso-'));
const hostedData = path.join(tmp, 'hosted');
const agentData = path.join(tmp, 'agent');
const agentSecrets = path.join(tmp, 'agent-secrets');
let hosted = null;
let agent = null;
let fixtures = null;
const revokeMs = {};

/** 一个项目的内容:文档 id 就是项目 id(与桌面版放云端的项目相同) */
function projectDoc(id, tag, secret) {
  return {
    version: 1, id, name: `项目${tag}-${secret}`, width: 1920, height: 1080, fps: 30, duration: 12, themeId: 'midnight',
    media: [{ id: `media-${tag}`, kind: 'image', name: `素材-${secret}.png`, url: `/api/asset/media/${'0'.repeat(64)}`, width: 10, height: 10 }],
    // 第二条轨给看画面那一组用:两个项目的画面一眼分得开(项目一绿、项目二紫)
    tracks: [{ id: 't1', name: '序列 1', clips: [{ id: `clip-${tag}`, cardId: 'title', start: 0, end: 4, params: {}, label: `文案-${secret}` }] }, lookTrack(tag)],
    transitions: [],
  };
}

const writes = (clipId, n, gap, prefix) => Array.from({ length: n }, (_, i) => [{ sleepMs: gap }, { tool: 'update_clip', input: { clipId, label: `${prefix}${i + 1}` } }]).flat();
const labelOf = (project, clipId) => project?.tracks?.flatMap((t) => t.clips).find((c) => c.id === clipId)?.label ?? null;
const historyOf = (projectId) => {
  const dir = path.join(agentData, 'tenants', projectId);
  return readTree(dir);
};

async function main() {
  for (const [name, port] of [['文档服务', DOC_PORT], ['素材服务', ASSET_PORT], ['Agent 服务', AGENT_PORT], ['收集站', COLLECTOR_PORT], ['替身配音服务', VOICE_PORT], ['同机别的服务', DECOY_PORT]]) {
    if (await portBusy(port)) throw new Error(`端口 ${port}(${name})已被占用`);
  }
  const gen = runKeygen(['--hosted-data', hostedData, '--secrets', agentSecrets, '--service', 'agent', '--instance-name', '云端 Agent(隔离探针)']);
  if (gen?.ok === false) throw new Error('keygen 失败');
  hosted = await startHosted({ dataDir: hostedData, docPort: DOC_PORT, assetPort: ASSET_PORT });

  const pw = () => `pw-${randomBytes(6).toString('hex')}`;
  const creds = Object.fromEntries(['owner1', 'owner2', 'jia', 'yi', 'bing', 'ding', 'wu', 'ji'].map((u) => [u, { username: u, password: pw() }]));
  const tag = randomBytes(4).toString('hex');
  const p1 = { ...(await createSharedProject({ base: BASE, name: `iso-one-${tag}`, mode: 'restricted', creator: creds.owner1, list: [creds.jia, creds.bing, creds.ding, creds.wu, creds.ji], kdf: KDF })), creator: creds.owner1 };
  const p2 = { ...(await createSharedProject({ base: BASE, name: `iso-two-${tag}`, mode: 'restricted', creator: creds.owner2, list: [creds.yi, creds.bing], kdf: KDF })), creator: creds.owner2 };

  // 只读成员:直接写项目记录(停进程、改文件、再起)
  await hosted.stop();
  const recFile = (id) => path.join(hostedData, 'docservice', 'auth', 'projects', `${id}.json`);
  const readRecord = (id) => JSON.parse(fs.readFileSync(recFile(id), 'utf8'));
  const rec1 = readRecord(p1.projectId);
  rec1.readonly = ['ding'];
  fs.writeFileSync(recFile(p1.projectId), `${JSON.stringify(rec1, null, 2)}\n`);
  hosted = await startHosted({ dataDir: hostedData, docPort: DOC_PORT, assetPort: ASSET_PORT });

  const SECRET1 = `one-${randomBytes(6).toString('hex')}`;
  const SECRET2 = `two-${randomBytes(6).toString('hex')}`;
  const owner1 = await joinAs(BASE, p1, { ...creds.owner1, as: 'creator' });
  const owner2 = await joinAs(BASE, p2, { ...creds.owner2, as: 'creator' });
  await putProject(owner1, p1.projectId, projectDoc(p1.projectId, 'one', SECRET1));
  await putProject(owner2, p2.projectId, projectDoc(p2.projectId, 'two', SECRET2));

  // 假凭证与替身先就位(在 Agent 服务起来之前):私钥目录、数据目录、托管服务的数据目录、一个「系统文件」里各放一份
  fixtures = await prepareToolFixtures({ tmp, agentData, agentSecrets, hostedData, assetPort: ASSET_PORT, collectorPort: COLLECTOR_PORT, voicePort: VOICE_PORT, decoyPort: DECOY_PORT });
  agent = await startAgent({ dataDir: agentData, secrets: agentSecrets, docPort: DOC_PORT, port: AGENT_PORT, env: { ...fixtures.env, ...(LOOK ? { PROMPTCUT_AGENT_LOOK_URL: `http://127.0.0.1:${RENDER_PORT + 6}` } : {}) } });
  const URL_A = agent.url;

  let jia = await joinAs(BASE, p1, creds.jia);
  const yi = await joinAs(BASE, p2, creds.yi);
  const bing1 = await joinAs(BASE, p1, creds.bing);
  const bing2 = await joinAs(BASE, p2, { ...creds.bing, device: bing1.device });
  const ding = await joinAs(BASE, p1, creds.ding);
  const wu = await joinAs(BASE, p1, creds.wu);
  const ji = await joinAs(BASE, p1, creds.ji);
  if (!jia || !yi || !bing1 || !bing2 || !ding || !wu || !ji) throw new Error('成员没进成项目');
  const A = { jia: agentApi(URL_A, jia), yi: agentApi(URL_A, yi), bing1: agentApi(URL_A, bing1), bing2: agentApi(URL_A, bing2), ding: agentApi(URL_A, ding), wu: agentApi(URL_A, wu), ji: agentApi(URL_A, ji) };
  /** 探针经手过的票据原文:最后查它们有没有落盘、进日志 */
  const secrets = new Set();
  const note = (t) => { if (typeof t === 'string' && t.length > 20) secrets.add(t); return t; };

  // ---------- V0～V3 看画面(放最前:它要起停渲染服务,做完就把它停掉,后面各组不带着它跑)
  if (LOOK) {
    await runLookIsolation({
      tmp, hostedData, base: BASE, agentUrl: URL_A, agentData, agentSecrets, renderPort: RENDER_PORT,
      projects: { p1, p2 }, pages: { jia, yi, owner1 }, apis: { jia: A.jia, yi: A.yi }, check,
    });
  }

  // ---------- I1 不带票据、乱写的票据
  {
    const paths = [['GET', '/v1/info'], ['GET', '/v1/conversations'], ['GET', '/v1/usage'], ['GET', '/v1/conversations/c1'], ['GET', '/v1/conversations/c1/events'], ['POST', '/v1/conversations/c1/messages'], ['POST', '/v1/conversations/c1/abort'], ['DELETE', '/v1/conversations/c1']];
    const out = [];
    for (const [method, p] of paths) {
      for (const headers of [{}, { Authorization: 'Bearer v1.aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb' }, { Authorization: 'Basic abc' }]) {
        const res = await fetch(`${URL_A}${p}`, { method, headers: { ...headers, ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}) }, ...(method === 'POST' ? { body: '{"prompt":"x"}' } : {}) });
        const body = await res.json().catch(() => ({}));
        out.push({ status: res.status, code: body.code, leak: JSON.stringify(body).length > 80 });
      }
    }
    const health = await (await fetch(`${URL_A}/healthz`)).json();
    check('I1 不带票据、乱写的票据打每个接口全 401,不说原因', out.every((o) => o.status === 401 && o.code === 'unauthorized' && !o.leak) && health.ok === true && !('projects' in health), {
      requests: out.length, statuses: [...new Set(out.map((o) => o.status))], healthzKeys: Object.keys(health),
    });
  }

  // ---------- I2 / I3 甲的对话读不到、改不了项目二
  {
    const before2 = await projectOf(owner2, p2.projectId);
    const before1 = await projectOf(owner1, p1.projectId);
    const sent = await A.jia.send('conv-jia', mockScript([
      { tool: 'get_project', input: {} },
      { tool: 'list_media', input: {} },
      { tool: 'get_clip', input: { clipId: 'clip-two' } },
      { tool: 'update_clip', input: { clipId: 'clip-two', label: '甲的 Agent 想改项目二' } },
      { tool: 'update_clip', input: { clipId: 'clip-one', label: '甲的 Agent 改了项目一' } },
      { say: '做完了' },
    ]), { extra: { projectId: p2.projectId, userId: yi.userId, sessionId: 'someone-else', tenantId: p2.projectId } });
    const ev = await A.jia.events('conv-jia');
    const results2 = ev.events.filter((e) => e.type === 'tool_result');
    const after2 = await projectOf(owner2, p2.projectId);
    const after1 = await projectOf(owner1, p1.projectId);
    const hist = historyOf(p1.projectId);
    const cross = await jia.ask({ type: 'auth.ticket', kind: 'delegate', audience: 'agent' });
    const joinTwo = await joinAs(BASE, p2, creds.jia);
    check('I2 成员甲的对话读不到成员乙的项目', sent.status === 202 && ev.done && hist.includes(SECRET1) && !hist.includes(SECRET2) && !JSON.stringify(ev.events).includes(SECRET2) && joinTwo === null
      && results2.length === 5 && results2[0].ok === true && results2[2].ok === false, {
      sent: sent.status, toolResults: results2.map((r) => `${r.name}:${r.ok ? 'ok' : 'error'}`),
      historyHasOwnProject: hist.includes(SECRET1), historyHasOtherProject: hist.includes(SECRET2), jiaJoinsProjectTwo: joinTwo !== null, ownDelegation: cross.type,
    });
    joinTwo?.close();
    check('I3 成员甲的对话改不了成员乙的项目;自报的项目与成员不被采信', after2.rev === before2.rev && labelOf(after2.project, 'clip-two') === `文案-${SECRET2}` && results2[4].ok === true && !JSON.stringify(after1.project).includes('想改项目二')
      && after1.rev === before1.rev + 1 && labelOf(after1.project, 'clip-one') === '甲的 Agent 改了项目一', {
      projectTwoRev: [before2.rev, after2.rev], projectTwoLabelUnchanged: labelOf(after2.project, 'clip-two') === `文案-${SECRET2}`,
      projectOneRev: [before1.rev, after1.rev], projectOneLabel: labelOf(after1.project, 'clip-one'), crossWriteLandedAnywhere: JSON.stringify(after1.project).includes('想改项目二') || JSON.stringify(after2.project).includes('想改项目二'),
    });
  }

  // ---------- I3b 写入的署名
  {
    const seen = [];
    const off = owner1.ws.addEventListener('message', () => {});
    void off;
    const mark = owner1.all.length;
    const sent = await A.jia.send('conv-jia', mockScript([{ tool: 'update_clip', input: { clipId: 'clip-one', label: '署名看这一次' } }, { say: 'ok' }]));
    await A.jia.settled('conv-jia');
    await sleep(300);
    for (const m of owner1.all.slice(mark)) if (m.type === 'project.ops' || m.type === 'project.op') seen.push(m);
    const w = seen.find((m) => m.by || m.identity || m.actor) ?? seen[0] ?? null;
    const who = w?.by ?? w?.identity ?? w?.actor ?? null;
    const members = await owner1.ask({ type: 'shared.members' });
    check('I3b 改动的署名是甲本人加 service: agent(界面据此显示「甲的云端 Agent」)', sent.status === 202 && who?.userId === jia.userId && who?.role === 'agent' && who?.service === 'agent', {
      writer: who ? { userId: who.userId === jia.userId ? '甲的 userId' : '别人', role: who.role, service: who.service ?? null, conversation: who.conversation ?? null } : null,
      broadcastTypes: [...new Set(seen.map((m) => m.type))], hostedAgent: members.hosted?.agent ?? null,
    });
  }

  // ---------- I4 对话记录不串项目、不串成员
  {
    const s1 = await A.bing1.send('conv-bing', mockScript([{ tool: 'update_clip', input: { clipId: 'clip-one', label: '丙在项目一' } }, { say: `丙在项目一说的话 ${SECRET1}` }]));
    const s2 = await A.bing2.send('conv-bing', mockScript([{ tool: 'update_clip', input: { clipId: 'clip-two', label: '丙在项目二' } }, { say: `丙在项目二说的话 ${SECRET2}` }]));
    const e1 = await A.bing1.events('conv-bing');
    const e2 = await A.bing2.events('conv-bing');
    // 再在项目一里开一个只在项目一有的对话
    await A.bing1.send('conv-only-one', mockScript([{ say: `只在项目一 ${SECRET1}` }]));
    await A.bing1.settled('conv-only-one');
    const list2 = await A.bing2.list();
    const get2 = await A.bing2.meta('conv-only-one');
    const ev2 = await A.bing2.events('conv-only-one', { ms: 3000 });
    const del2 = await A.bing2.call('DELETE', '/v1/conversations/conv-only-one');
    const abort2 = await A.bing2.abort('conv-only-one');
    const still = await A.bing1.meta('conv-only-one');
    // 同一项目里别的成员:甲读丙的
    const jiaGet = await A.jia.meta('conv-bing');
    const jiaEv = await A.jia.events('conv-bing', { ms: 3000 });
    const jiaList = await A.jia.list();
    const jiaDel = await A.jia.call('DELETE', '/v1/conversations/conv-bing');
    // 项目二的成员乙读项目一的对话
    const yiGet = await A.yi.meta('conv-jia');
    const yiEv = await A.yi.events('conv-jia', { ms: 3000 });
    const t1 = JSON.stringify(e1.events);
    const t2 = JSON.stringify(e2.events);
    check('I4 一个项目的对话拿不到另一个项目的对话记录;同项目里别的成员也读不到', s1.status === 202 && s2.status === 202
      && t1.includes(SECRET1) && !t1.includes(SECRET2) && t2.includes(SECRET2) && !t2.includes(SECRET1)
      && !list2.items.some((i) => i.id === 'conv-only-one') && get2.status === 404 && ev2.events.every((e) => e.type === 'end' && e.state === 'none') && del2.status === 404 && still.status === 200
      && jiaGet.status === 404 && jiaEv.events.every((e) => e.state === 'none') && !jiaList.items.some((i) => i.id === 'conv-bing') && jiaDel.status === 404
      && yiGet.status === 404 && yiEv.events.every((e) => e.state === 'none'), {
      sameIdTwoProjects: { projectOneSeesOnlyOwn: t1.includes(SECRET1) && !t1.includes(SECRET2), projectTwoSeesOnlyOwn: t2.includes(SECRET2) && !t2.includes(SECRET1) },
      withProjectTwoTicket: { listed: list2.items.map((i) => i.id), get: get2.status, events: ev2.events.map((e) => e.state ?? e.type), delete: del2.status, abort: abort2.status, stillThere: still.status === 200 },
      otherMemberSameProject: { get: jiaGet.status, events: jiaEv.events.map((e) => e.state ?? e.type), listed: jiaList.items.map((i) => i.id), delete: jiaDel.status },
      otherProjectMember: { get: yiGet.status, events: yiEv.events.map((e) => e.state ?? e.type) },
    });
  }

  // ---------- I5 素材
  {
    await A.yi.send('conv-yi', mockScript([{ tool: 'list_media', input: {} }, { say: 'ok' }]));
    await A.yi.settled('conv-yi');
    const h1 = historyOf(p1.projectId);
    const h2 = historyOf(p2.projectId);
    const probes = [];
    const short = note((await delegationOf(jia)).ticket);
    for (const p of ['/api/asset/media/' + '0'.repeat(64), '/v1/assets', '/v1/media', '/media/x', '/api/media/list', '/v1/conversations/conv-jia/assets']) {
      const res = await fetch(`${URL_A}${p}`, { headers: { Authorization: `Bearer ${short}` } });
      probes.push(res.status);
    }
    check('I5 一个项目的对话拿不到另一个项目的素材;Agent 服务没有取素材的接口', h1.includes(`素材-${SECRET1}`) && !h1.includes(`素材-${SECRET2}`) && h2.includes(`素材-${SECRET2}`) && !h2.includes(`素材-${SECRET1}`) && probes.every((s) => s === 404), {
      projectOneHistory: { own: h1.includes(`素材-${SECRET1}`), other: h1.includes(`素材-${SECRET2}`) }, projectTwoHistory: { own: h2.includes(`素材-${SECRET2}`), other: h2.includes(`素材-${SECRET1}`) }, assetRoutes: probes,
    });
  }

  // ---------- T1～T5 工具:素材写入、文件隔离、出网闸、花钱的调用、建卡改卡
  await runToolIsolation({
    fx: fixtures, check, A, jia, bing2, owner1, owner2, p1, p2, projectOf, historyOf, agent, agentUrl: URL_A,
    agentData, agentSecrets, hostedData, tmp, ports: { doc: DOC_PORT, asset: ASSET_PORT, agent: AGENT_PORT, decoy: DECOY_PORT },
  });

  // ---------- I6 / I7 伪造、过期
  {
    const flip = (t) => { const i = t.lastIndexOf('.') + 1; return t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1); };
    const tamper = (t, patch) => { const [v, body, sig] = t.split('.'); const j = { ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')), ...patch }; return `${v}.${Buffer.from(JSON.stringify(j), 'utf8').toString('base64url')}.${sig}`; };
    const real = readRecord(p1.projectId);
    const short = note((await delegationOf(jia)).ticket);
    const grant = note((await delegationOf(jia, 'conv-jia')).ticket);
    const grantOther = note((await delegationOf(jia, 'conv-else')).ticket);
    const grantBing = note((await delegationOf(bing1, 'conv-jia')).ticket);
    const selfSigned = signDelegation({ ...real, ticketKey: randomBytes(32).toString('base64url') }, { u: jia.userId, aud: 'agent', acc: 'rw' }, Date.now()).ticket;
    const otherKey = signDelegation({ ...real, ticketKey: readRecord(p2.projectId).ticketKey }, { u: jia.userId, aud: 'agent', acc: 'rw' }, Date.now()).ticket;
    const bearers = { 签名改一个字符: flip(short), 自己造密钥签: selfSigned, 用项目二的密钥签项目一的: otherKey, 把成员改成乙: tamper(short, { u: yi.userId }), 把项目改成项目二: tamper(short, { p: p2.projectId }), 把有效期改长: tamper(short, { exp: Date.now() + 86_400_000 }) };
    const asBearer = {};
    for (const [k, b] of Object.entries(bearers)) {
      const a = await A.jia.info({ bearer: b });
      const m = await A.jia.send('conv-forged', mockScript([{ tool: 'update_clip', input: { clipId: 'clip-one', label: '伪造票据改的' } }]), { bearer: b });
      asBearer[k] = [a.status, m.status];
    }
    const rev0 = (await projectOf(owner1, p1.projectId)).rev;
    const grants = { 签名改一个字符: flip(grant), 把成员改成乙: tamper(grant, { u: yi.userId }), 把对话改成别的: tamper(grant, { cid: 'conv-forged' }), 别的对话的委托: grantOther, 别的成员的委托: grantBing, 短的委托票据冒充: short, 不带委托: null, 乱写: 'v1.aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbbbb' };
    const asGrant = {};
    for (const [k, g] of Object.entries(grants)) {
      const m = await A.jia.send('conv-forged', mockScript([{ tool: 'update_clip', input: { clipId: 'clip-one', label: '伪造委托改的' } }]), { grant: g });
      asGrant[k] = `${m.status}:${m.code ?? ''}`;
    }
    await sleep(500);
    const rev1 = (await projectOf(owner1, p1.projectId)).rev;
    const forgedConv = await A.jia.meta('conv-forged');
    check('I6 伪造的成员身份证明被拒', Object.values(asBearer).every(([a, m]) => a === 401 && m === 401) && Object.values(asGrant).every((v) => v === '403:bad-grant') && rev1 === rev0 && forgedConv.status === 404, {
      asBearer, asGrant, projectRevUnchanged: rev1 === rev0, conversationCreated: forgedConv.status !== 404,
    });

    const at = Date.now();
    const expiredShort = signDelegation(real, { u: jia.userId, aud: 'agent', acc: 'rw' }, at - (2 * 60_000 + 31_000)).ticket;
    const expiredGrant = signDelegation(real, { u: jia.userId, aud: 'agent', acc: 'rw', cid: 'conv-expired' }, at - (60 * 60_000 + 31_000)).ticket;
    const liveGrant = signDelegation(real, { u: jia.userId, aud: 'agent', acc: 'rw', cid: 'conv-expired' }, at - 59 * 60_000).ticket;
    const a = await A.jia.info({ bearer: expiredShort });
    const b = await A.jia.send('conv-expired', mockScript([{ say: '过期的委托' }]), { grant: expiredGrant });
    const c = await A.jia.send('conv-expired', mockScript([{ say: '59 分钟的委托还能用' }]), { grant: liveGrant });
    if (c.status === 202) await A.jia.settled('conv-expired');
    check('I7 过期的成员身份证明被拒', a.status === 401 && b.status === 403 && b.code === 'bad-grant' && c.status === 202, {
      shortAfter2m31s: a.status, grantAfter60m31s: `${b.status}:${b.code ?? ''}`, grantAt59m: c.status,
    });
  }

  // ---------- I8 只读成员
  {
    const before = await projectOf(owner1, p1.projectId);
    const sent = await A.ding.send('conv-ding', mockScript([{ tool: 'get_project', input: {} }, { tool: 'update_clip', input: { clipId: 'clip-one', label: '只读成员想改' } }, { say: '改不了' }]));
    const ev = await A.ding.events('conv-ding');
    const rs = ev.events.filter((e) => e.type === 'tool_result');
    const after = await projectOf(owner1, p1.projectId);
    check('I8 只读成员发起的对话改不了项目(读照常)', sent.status === 202 && ev.done && rs.length === 2 && rs[0].ok === true && rs[1].ok === false && after.rev === before.rev && labelOf(after.project, 'clip-one') !== '只读成员想改', {
      sent: sent.status, toolResults: rs.map((r) => `${r.name}:${r.ok ? 'ok' : 'error'}`), rev: [before.rev, after.rev], refusedAs: String(rs[1]?.summary ?? '').slice(0, 160),
    });
  }

  /** 起一个连续写入的对话,等它落地两次;回 `{ api, id }` */
  async function runningWrites(api, id, clipId, prefix, observer, docId) {
    const sent = await api.send(id, mockScript([...writes(clipId, 40, 250, prefix), { say: '不该说到这句' }]));
    if (sent.status !== 202) throw new Error(`${id} 没起来:${sent.status} ${sent.code}`);
    await waitFor(async () => String(labelOf((await projectOf(observer, docId)).project, clipId) ?? '').startsWith(prefix), 20_000, `${id} 开始写入`, 100);
    return sent;
  }
  /** 看着对话的事件流,回一个取结果的函数 */
  function watch(api, id) {
    const p = api.events(id, { ms: 30_000 });
    return async () => {
      const r = await p;
      const err = r.events.find((e) => e.type === 'error');
      const end = r.events.find((e) => e.type === 'end');
      return { err, end, events: r.events };
    };
  }
  const stableRev = async (observer, docId) => { const a = (await projectOf(observer, docId)).rev; await sleep(1500); const b = (await projectOf(observer, docId)).rev; return { a, b, stable: a === b }; };

  // ---------- I9 创建者关开关(成员此时不在线)
  {
    await runningWrites(A.jia, 'conv-run', 'clip-one', '甲在写', owner1, p1.projectId);
    await runningWrites(A.bing2, 'conv-keep', 'clip-two', '丙在项目二写', owner2, p2.projectId);
    const view = watch(A.jia, 'conv-run'); // 流在甲的页面断开之前先接上(用的是它那一刻的票据)
    await sleep(400);
    const jiaApi = A.jia;
    jia.close(); // 甲的页面连接全部断开:成员不在线
    await sleep(300);
    const members = await owner1.ask({ type: 'shared.members' });
    const jiaRow = (members.devices ?? []).filter((d) => d.username === 'jia');
    const t0 = Date.now();
    const off = await adminOp(owner1, p1, 'set-hosted-service', { service: 'agent', enabled: false });
    const got = await view();
    revokeMs.disabled = got.err ? got.err._at - t0 : null;
    const rev = await stableRev(owner1, p1.projectId);
    // 甲回来:拿不到委托,请求被拒
    jia = await joinAs(BASE, p1, creds.jia);
    A.jia = agentApi(URL_A, jia);
    const noDelegation = await delegationOf(jia);
    const stale = await jiaApi.info(); // 旧页面连接已关,要不到票据 → 401
    const keep = await A.bing2.meta('conv-keep');
    const on = await adminOp(owner1, p1, 'set-hosted-service', { service: 'agent', enabled: true });
    await sleep(300);
    const meta = await A.jia.meta('conv-run');
    const replay = await A.jia.events('conv-run', { ms: 5000 });
    const again = await A.jia.send('conv-run', mockScript([{ tool: 'update_clip', input: { clipId: 'clip-one', label: '开回来后改的' } }, { say: '恢复了' }]));
    const back = again.status === 202 ? await A.jia.settled('conv-run') : null;
    // 两条路哪条先到算哪条:文档服务以 4003 关掉数据连接,或控制连接上的目录推送
    const log = agent.logs.filter((l) => l.event === 'agent.link.final-close' || l.event === 'agent.directory.disabled').map((l) => (l.event === 'agent.directory.disabled' ? '目录推送' : `${l.code}:${l.reason}`));
    check('I9 创建者关掉开关后正在进行的对话被停掉(成员不在线),记录里留原因;只停这个项目的;开回来恢复', off.type === 'shared.admin.ok'
      && got.err?.code === 'revoked' && got.err?.reason === 'disabled' && got.end?.state === 'revoked' && revokeMs.disabled !== null && revokeMs.disabled <= 2000
      && rev.stable && noDelegation.ticket === null && noDelegation.reason === 'service-disabled' && keep.meta?.state === 'running'
      && on.type === 'shared.admin.ok' && meta.meta?.state === 'revoked' && meta.meta?.reason === 'disabled' && typeof meta.meta?.message === 'string'
      && replay.events.some((e) => e.type === 'error' && e.code === 'revoked') && back?.state === 'idle' && log.length > 0, {
      memberPagesOnline: jiaRow.flatMap((d) => (d.conns ?? []).filter((c) => c.role === 'page')).length, stoppedInMs: revokeMs.disabled,
      error: got.err ? { code: got.err.code, reason: got.err.reason, message: got.err.message } : null, end: got.end?.state ?? null,
      revAfterStop: [rev.a, rev.b], delegationWhileOff: noDelegation.reason ?? 'issued', stalePage: stale.status, otherProjectConversation: keep.meta?.state ?? null,
      recorded: meta.meta ? { state: meta.meta.state, reason: meta.meta.reason, message: meta.meta.message } : null, afterReopen: back?.state ?? `${again.status}:${again.code}`, stoppedVia: log,
    });
    // 关着的时候发消息
    const off2 = await adminOp(owner1, p1, 'set-hosted-service', { service: 'agent', enabled: false });
    await sleep(300);
    const dWu = await A.wu.send('conv-wu-off', mockScript([{ say: 'x' }]));
    const infoOff = await A.wu.info();
    await adminOp(owner1, p1, 'set-hosted-service', { service: 'agent', enabled: true });
    await sleep(300);
    check('I9b 开关关着时任何请求都被拒(取不到委托;旧委托 403 disabled)', off2.type === 'shared.admin.ok' && [401, 403].includes(dWu.status) && [401, 403].includes(infoOff.status), { send: `${dWu.status}:${dWu.code ?? ''}`, info: `${infoOff.status}:${infoOff.code ?? ''}` });
    await A.bing2.abort('conv-keep');
  }

  // ---------- I10 成员被移出名单
  {
    await runningWrites(A.wu, 'conv-wu', 'clip-one', '戊在写', owner1, p1.projectId);
    const view = watch(A.wu, 'conv-wu');
    await sleep(400);
    const t0 = Date.now();
    const r = await adminOp(owner1, p1, 'set-list', { list: ['jia', 'bing', 'ding', 'ji'].map((username) => ({ username, keep: true })) });
    const got = await view();
    revokeMs.removed = got.err ? got.err._at - t0 : null;
    const rev = await stableRev(owner1, p1.projectId);
    const after = await A.wu.meta('conv-wu');
    const onDisk = readTree(path.join(agentData, 'tenants', p1.projectId)).includes('戊在写');
    check('I10 成员被移出名单:进行中的对话 2 秒内停下,原因 removed;他之后读不到', r.type === 'shared.admin.ok' && got.err?.code === 'revoked' && got.err?.reason === 'removed' && got.end?.state === 'revoked'
      && revokeMs.removed <= 2000 && rev.stable && after.status === 401, {
      stoppedInMs: revokeMs.removed, error: got.err ? { code: got.err.code, reason: got.err.reason, message: got.err.message } : null, revAfterStop: [rev.a, rev.b], readAfterRemoved: after.status, recordKeptOnDisk: onDisk,
    });
    // 改名单让项目代数加一:留下的成员重新进入
    for (const c of [jia, bing1, ding, ji]) c.close();
    jia = await joinAs(BASE, p1, creds.jia);
    A.jia = agentApi(URL_A, jia);
  }

  // ---------- I11 成员被踢
  {
    const ji2 = await joinAs(BASE, p1, creds.ji);
    const apiJi = agentApi(URL_A, ji2);
    await runningWrites(apiJi, 'conv-ji', 'clip-one', '己在写', owner1, p1.projectId);
    const view = watch(apiJi, 'conv-ji');
    await sleep(400);
    const t0 = Date.now();
    const r = await adminOp(owner1, p1, 'kick', { username: 'ji', deviceId: ji2.device.deviceId });
    const got = await view();
    revokeMs.kicked = got.err ? got.err._at - t0 : null;
    const rev = await stableRev(owner1, p1.projectId);
    check('I11 成员被踢:进行中的对话 2 秒内停下,原因 kicked', r.type === 'shared.admin.ok' && got.err?.code === 'revoked' && got.err?.reason === 'kicked' && got.end?.state === 'revoked' && revokeMs.kicked <= 2000 && rev.stable, {
      stoppedInMs: revokeMs.kicked, error: got.err ? { code: got.err.code, reason: got.err.reason, message: got.err.message } : null, revAfterStop: [rev.a, rev.b],
    });
  }

  // ---------- I14 并发上限(删项目之前做)
  {
    const long = mockScript([{ sleepMs: 6000 }, { say: '占着名额' }]);
    const s = [];
    for (const id of ['conv-c1', 'conv-c2', 'conv-c3']) s.push(await A.yi.send(id, long));
    await A.yi.abort('conv-c1');
    await A.yi.settled('conv-c1');
    const s4 = await A.yi.send('conv-c3', long);
    for (const id of ['conv-c2', 'conv-c3']) await A.yi.abort(id);
    const heap = agent.ready?.heapLimitMb ?? null;
    check('I14 节点资源:每位成员同时进行的一轮不超过 2,超了回 429 busy,结束后名额释放;堆上限与启动参数相符', s[0].status === 202 && s[1].status === 202 && s[2].status === 429 && s[2].code === 'busy' && s4.status === 202
      && heap !== null && heap >= 1536 && heap <= 1800, {
      sends: s.map((x) => `${x.status}:${x.code ?? 'ok'}`), busyMessage: s[2].message ?? null, afterRelease: s4.status, heapLimitMb: heap, nodeArgs: '--max-old-space-size=1536',
    });
    await A.yi.settled('conv-c3');
  }

  // ---------- I12 项目删除
  {
    await runningWrites(A.bing2, 'conv-del', 'clip-two', '删之前丙在写', owner2, p2.projectId);
    const view = watch(A.bing2, 'conv-del');
    await sleep(400);
    const dir = path.join(agentData, 'tenants', p2.projectId);
    const before = fs.existsSync(dir);
    const t0 = Date.now();
    const r = await adminOp(owner2, p2, 'delete');
    const got = await view();
    revokeMs.deleted = got.err ? got.err._at - t0 : null;
    await waitFor(() => !fs.existsSync(dir), 5000, '项目二的对话目录被删').catch(() => null);
    const usage = readTree(path.join(agentData, 'usage'));
    check('I12 项目删除:进行中的对话 2 秒内停下;这个项目的对话记录与模型历史被删,用量记录留着', r.type === 'shared.admin.ok' && got.err?.code === 'revoked' && got.err?.reason === 'deleted'
      && revokeMs.deleted <= 2000 && before && !fs.existsSync(dir) && usage.includes(p2.projectId) && fs.existsSync(path.join(agentData, 'tenants', p1.projectId)), {
      stoppedInMs: revokeMs.deleted, error: got.err ? { code: got.err.code, reason: got.err.reason } : null, tenantDirBefore: before, tenantDirAfter: fs.existsSync(dir), usageKept: usage.includes(p2.projectId), otherProjectKept: fs.existsSync(path.join(agentData, 'tenants', p1.projectId)),
    });
  }

  // ---------- I13 不落盘、不进日志
  {
    await sleep(500);
    const disk = readTree(agentData);
    const log = agent.text();
    const all = [...secrets];
    const onDisk = all.filter((t) => disk.includes(t)).length;
    const inLog = all.filter((t) => log.includes(t)).length;
    const anyTicket = /v1\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(disk) || /v1\.eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/.test(log);
    check('I13 委托票据、对话委托、连接票据的原文不落盘、不进日志', all.length >= 5 && onDisk === 0 && inLog === 0 && !anyTicket, { tracked: all.length, onDisk, inLog, anyTicketShapedText: anyTicket, logBytes: log.length, diskBytes: disk.length });
  }

  for (const c of [owner1, owner2, jia, yi, bing1, bing2, ding, wu, ji]) c?.close();
}

let code = 0;
try {
  await main();
} catch (err) {
  code = 2;
  process.stdout.write(`${JSON.stringify({ check: '探针自身', ok: false, error: String(err?.stack ?? err).slice(0, 1200), agentLogTail: agent ? agent.text().slice(-1500) : null })}\n`);
} finally {
  await agent?.stop();
  await hosted?.stop();
  await fixtures?.close().catch(() => {});
  if (!KEEP) { try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* 留给系统清 */ } }
}
const failed = results.filter((r) => !r.ok);
if (code === 0 && failed.length) code = 1;
const finalCloses = agent ? agent.logs.filter((l) => l.event === 'agent.link.final-close').map((l) => `${l.code}:${l.reason}`) : [];
process.stdout.write(`${JSON.stringify({ ok: code === 0, passed: results.filter((r) => r.ok).length, failed: failed.map((r) => r.check), revokeMs, dataConnectionsClosedByDocService: [...new Set(finalCloses)], ...(KEEP ? { tmp } : {}) })}\n`);
process.exit(code);
