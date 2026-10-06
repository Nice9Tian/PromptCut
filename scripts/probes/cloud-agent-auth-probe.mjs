/**
 * 云端 Agent 的隔离探针：文档服务与素材服务一侧（任务书 `docs/plan/cloud-agent-task.md` 完成条件第 4 条；
 * 契约 `docs/plan/cloud-agent-contract.md` 第 4、13 节）。不依赖 Agent 服务本体。
 *
 * 用法：
 *   node scripts/probes/cloud-agent-auth-probe.mjs [--doc-port 8784] [--asset-port 8785] [--keep]
 *
 * 搭法（全部在本机、后台静默，结束时只结束自己起的进程、删自己建的临时目录；不连任何远端）：
 * - 一个临时数据目录；用 `server/hosted-render/keygen.mjs` 生成 `agent`、`render` 两个服务的密钥；
 * - 起一个**真的托管组合进程**（`server/hosted/main.mjs`，文档服务 8784、素材服务 8785，只绑回环，
 *   `PROMPTCUT_TRUST_LOOPBACK=0`——与云节点在 nginx 之后的配置相同，回环来的请求不算本机）；
 * - 成员一侧用真的客户端（`server/auth/client.mjs`）建项目、握手、做创建者操作；
 * - **假 Agent 服务**：直接拿服务私钥，经 `server/auth/service-client.mjs` 走真握手、真控制连接，凭对话委托换票据后开真的数据连接。
 *   它扮演的是「被攻破或写错了的 Agent 服务」：能发任何消息、带任何字段，断言文档服务与素材服务这一侧仍然守得住。
 *
 * 人物：项目一（限定进入）有甲、丙、丁（丁是只读的，直接写项目记录造出来）；项目二（限定进入）有乙、丙。
 *
 * 验收标准（每条一行 JSON `{ check, ok, … }`，最后一行 `{ summary }`；任何一条不过退出码 1）：
 *   P1  成员甲的对话读不到成员乙的项目：甲的对话委托换不出项目二的连接（`project`）；甲的 Agent 连接读到的是项目一的内容，
 *       读不到项目二那份同名文档里的标记；甲自己进不了项目二（握手 401），所以也要不到项目二的委托。
 *   P2  成员甲的对话改不了成员乙的项目：甲的 Agent 连接提交的写入只落在项目一，项目二的版本号与内容不变。
 *   P3  一个项目的对话拿不到另一个项目的内容：丙在两个项目都有权限，但他在项目一的对话的连接读不到项目二的内容；
 *       项目一的对话委托拿去换项目二的连接被拒；消息里自报项目、自报成员都不认。
 *   P4  一个项目的对话拿不到另一个项目的素材，也拿不到本项目的素材字节：Agent 的连接要不到素材票据；
 *       委托、对话委托、Agent 的连接票据拿去素材服务一律 401；成员自己的票据照常能读（对照）。
 *   P5  对话记录的归属由文档服务定：核验委托回的 `projectId`、`userId`、`ownerKey` 只取自委托本身，
 *       项目一的委托核验不出项目二的归属（对话记录本身在 Agent 服务侧，这里断言的是它据以分目录的那几个字段伪造不了）。
 *   P6  伪造的成员身份证明被拒：改签名、改负载、用别的密钥签、拿连接票据或素材票据冒充，核验与换票据都拒；委托直接当握手票据 401。
 *   P7  过期的成员身份证明被拒：过期的委托票据（2 分钟）与过期的对话委托（60 分钟）核验与换票据都回 `expired`
 *       （用项目真正的签名密钥签一张签发时刻在过去的，等于时间走过了有效期）。
 *   P8  只读成员发起的对话改不了项目：丁的委托 `acc` 是 `r`，换出的连接读得到、`project.op` 与 `project.upload` 被拒，版本号不变。
 *   P9  白名单：Agent 的连接发表外的消息（取票据、成员列表、创建者操作、报到成渲染节点、认领、写内容库、发布任务）一律 `forbidden`。
 *   P10 创建者关掉开关后正在进行的对话被停掉：对话正在连续提交写入，创建者（从自己的连接）关开关，
 *       Agent 的连接在 2 秒内以 4003 `service-disabled` 关闭，之后没有新的写入落地，委托换不出新票据、核验不过；
 *       项目二里丙的对话不受影响；开关开回来后恢复。
 *   P11 成员被踢后对话被停掉：丙在项目一的连接 2 秒内以 4003 `kicked` 关闭，他的委托当场失效；发起成员不在线也一样。
 *   P12 成员被移出名单后对话被停掉：甲的连接 2 秒内以 4003 `removed` 关闭，委托当场失效。
 *   P13 项目删除后对话被停掉：项目一剩下的 Agent 连接 2 秒内以 4004 `deleted` 关闭，委托换不出（`no-project`）。
 *   P14 只用来发布补渲计划的连接：能发带片段清单的计划，读不了项目、改不了项目、取不了票据；成员被踢、被移出不影响它。
 *   P15 托管组合的日志里没有委托、对话委托、票据的原文。
 *   P16 发起成员离线后对话委托继续有效：项目一的成员页面连接全部断开（成员列表里他们没有页面在线）之后，
 *       凭还在有效期内的对话委托仍能换到连接票据、连上、提交编辑；写入的署名是这位成员加 `service: 'agent'`，
 *       成员列表里归在他那一行、连接项带 `service: 'agent'`。
 *   P17 Agent 服务的对外地址由托管端配置下发：成员列表顶层 `hosted.agent` 带 `available`、`enabled`、`url`（`PROMPTCUT_AGENT_PUBLIC_URL`）。
 */
import '../lib/no-user-dirs.mjs';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  createSharedProject, buildAuthProtocols, deriveKey, adminProof, ticketProtocols,
} from '../../server/auth/client.mjs';
import { createServiceClient } from '../../server/auth/service-client.mjs';
import { readServiceKeyFile } from '../../server/auth/service-identity.mjs';
import { signDelegation } from '../../server/auth/delegation.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import { clipsPlanTaskOf } from '../../server/render-queue/messages.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');
const args = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback;
};
const DOC_PORT = Number(argOf('--doc-port', 8784));
const ASSET_PORT = Number(argOf('--asset-port', 8785));
const KEEP = args.includes('--keep');
const BASE = `ws://127.0.0.1:${DOC_PORT}`;
const ASSET = `http://127.0.0.1:${ASSET_PORT}/api/asset`;
const KDF = { alg: 'pbkdf2-sha256', iter: 100_000 };
/** 只是一个要原样下发的字符串；探针不连它 */
const AGENT_URL = 'https://probe.invalid/agent/v1';
const DOC = 'doc-1';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const results = [];
function check(name, ok, detail = {}) {
  const line = { check: name, ok: !!ok, ...detail };
  results.push(line);
  process.stdout.write(`${JSON.stringify(line)}\n`);
  return !!ok;
}

// ---------------------------------------------------------------- 托管组合进程

let child = null;
let childLog = '';
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-auth-probe-'));
const dataDir = path.join(tmpRoot, 'hosted');
const secretsDir = { agent: path.join(tmpRoot, 'agent-secrets'), render: path.join(tmpRoot, 'render-secrets') };
fs.mkdirSync(dataDir, { recursive: true });

async function startHosted() {
  const env = {
    ...process.env,
    PROMPTCUT_DATA_DIR: dataDir,
    PROMPTCUT_DOCSERVICE_PORT: String(DOC_PORT),
    PROMPTCUT_ASSET_PORT: String(ASSET_PORT),
    PROMPTCUT_DOCSERVICE_HOST: '127.0.0.1',
    PROMPTCUT_TRUST_LOOPBACK: '0',
    PROMPTCUT_AGENT_PUBLIC_URL: AGENT_URL,
    // 只给这个临时实例用的随机令牌（关掉本机信任时必须有）；探针自己不用它，不打印
    PROMPTCUT_CLUSTER_TOKEN: randomBytes(32).toString('base64url'),
  };
  child = spawn(process.execPath, [path.join(ROOT, 'server', 'hosted', 'main.mjs')], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (b) => { childLog += b.toString('utf8'); });
  child.stderr.on('data', (b) => { childLog += b.toString('utf8'); });
  const proc = child;
  const until = Date.now() + 30_000;
  for (;;) {
    if (proc.exitCode !== null) throw new Error(`托管组合没起来（退出码 ${proc.exitCode}）：${childLog.slice(-600)}`);
    try {
      const r = await fetch(`http://127.0.0.1:${DOC_PORT}/healthz`);
      if (r.ok) return;
    } catch { /* 还没监听 */ }
    if (Date.now() > until) throw new Error('托管组合 30 秒内没有监听');
    await sleep(100);
  }
}

async function stopHosted() {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return;
  const gone = new Promise((resolve) => proc.once('exit', resolve));
  proc.kill();
  await Promise.race([gone, sleep(5000)]);
}

// ---------------------------------------------------------------- 连接

let reqSeq = 0;
/** 一条 WebSocket：收到的消息排队；`ask` 按 reqId 等回包；`closed` 给关闭码与原因 */
function wsOpen(protocols) {
  const ws = new WebSocket(BASE, protocols);
  const all = [];
  const waiters = [];
  ws.addEventListener('message', (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    all.push(m);
    const i = waiters.findIndex((w) => w.match(m));
    if (i >= 0) waiters.splice(i, 1)[0].resolve(m);
  });
  const opened = new Promise((resolve) => {
    ws.addEventListener('open', () => resolve(true), { once: true });
    ws.addEventListener('error', () => resolve(false), { once: true });
  });
  const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve({ code: e.code, reason: e.reason, at: performance.now() }), { once: true }));
  const c = {
    ws, all, opened, closed,
    next(match, ms = 5000) {
      const hit = all.find(match);
      if (hit) return Promise.resolve(hit);
      return new Promise((resolve) => {
        const w = { match, resolve };
        waiters.push(w);
        setTimeout(() => {
          const k = waiters.indexOf(w);
          if (k >= 0) { waiters.splice(k, 1); resolve({ type: 'timeout' }); }
        }, ms);
      });
    },
    ask(message, ms = 5000) {
      const reqId = `p-${(reqSeq += 1)}`;
      try { ws.send(JSON.stringify({ ...message, reqId })); } catch { return Promise.resolve({ type: 'error', reason: 'closed' }); }
      return Promise.race([c.next((m) => m.reqId === reqId, ms), closed.then(() => ({ type: 'error', reason: 'closed' }))]);
    },
    close() { try { ws.close(); } catch { /* 已关 */ } },
  };
  return c;
}

/** 回包的结论：成功是类型，失败是 `error:<原因>` */
const verdict = (r) => (r.type === 'error' ? `error:${r.reason}` : r.type);

let devSeq = 0;
const newDevice = (name) => ({ deviceId: `probe-${process.pid}-${(devSeq += 1)}-${randomBytes(6).toString('hex')}`, deviceName: name });

/** 成员（或创建者）用口令进项目，回页面连接；进不去回 null */
async function joinAs(proj, { username, password, as = 'member', device = newDevice(`${username}-pc`) }) {
  const protocols = await buildAuthProtocols({ base: BASE, projectId: proj.projectId, username, deviceId: device.deviceId, deviceName: device.deviceName, as, password });
  const c = wsOpen(protocols);
  if (!(await c.opened)) return null;
  c.device = device;
  c.userId = `${username}@${device.deviceId}`;
  c.username = username;
  return c;
}

/** 创建者操作：同一条连接取挑战、算证明、发 shared.admin */
async function adminOp(creator, proj, op, fields = {}) {
  const ch = await creator.ask({ type: 'shared.challenge' });
  if (ch.type !== 'shared.challenge.ok') return ch;
  const key = await deriveKey(proj.creator.password, ch.salt, ch.kdf);
  const m = await adminProof({ key, projectId: proj.projectId, username: proj.creator.username, op, nonce: ch.nonce });
  return creator.ask({ type: 'shared.admin', op, ...fields, proof: { nonce: ch.nonce, m } });
}

const delegationOf = async (page, conversation) => (await page.ask({ type: 'auth.ticket', kind: 'delegate', audience: 'agent', ...(conversation ? { conversation } : {}) }));
const stateOf = (c) => c.ask({ type: 'project.open', projectId: DOC });
const opOf = (opId, name) => ({ type: 'project.op', projectId: DOC, opId, session: 's-probe', ops: [{ op: 'set', path: '/name', value: name }] });

// ---------------------------------------------------------------- 探针本体

async function main() {
  // 密钥：私钥在各自的目录里，公钥进托管数据目录的登记表
  for (const service of ['agent', 'render']) {
    const r = await runKeygen(['--hosted-data', dataDir, '--secrets', secretsDir[service], '--service', service]);
    if (r?.ok === false) throw new Error(`keygen ${service} 失败`);
  }
  await startHosted();

  const creds = {
    creator1: { username: 'owner1', password: `pw-${randomBytes(6).toString('hex')}` },
    creator2: { username: 'owner2', password: `pw-${randomBytes(6).toString('hex')}` },
    jia: { username: 'jia', password: `pw-${randomBytes(6).toString('hex')}` },
    yi: { username: 'yi', password: `pw-${randomBytes(6).toString('hex')}` },
    bing: { username: 'bing', password: `pw-${randomBytes(6).toString('hex')}` },
    ding: { username: 'ding', password: `pw-${randomBytes(6).toString('hex')}` },
  };
  const tag = randomBytes(4).toString('hex');
  const p1 = { ...(await createSharedProject({ base: BASE, name: `probe-one-${tag}`, mode: 'restricted', creator: creds.creator1, list: [creds.jia, creds.bing, creds.ding], kdf: KDF })), creator: creds.creator1 };
  const p2 = { ...(await createSharedProject({ base: BASE, name: `probe-two-${tag}`, mode: 'restricted', creator: creds.creator2, list: [creds.yi, creds.bing], kdf: KDF })), creator: creds.creator2 };

  // 只读成员：这一版没有设置它的界面与操作，直接写项目记录（停进程、改文件、再起）
  await stopHosted();
  const recFile = (id) => path.join(dataDir, 'docservice', 'auth', 'projects', `${id}.json`);
  const rec1 = JSON.parse(fs.readFileSync(recFile(p1.projectId), 'utf8'));
  rec1.readonly = ['ding'];
  fs.writeFileSync(recFile(p1.projectId), `${JSON.stringify(rec1, null, 2)}\n`);
  await startHosted();
  const readRecord = (id) => JSON.parse(fs.readFileSync(recFile(id), 'utf8'));

  // 两个项目各放一份同名文档，内容里带各自的标记
  const SECRET1 = `secret-one-${randomBytes(6).toString('hex')}`;
  const SECRET2 = `secret-two-${randomBytes(6).toString('hex')}`;
  const owner1 = await joinAs(p1, { ...creds.creator1, as: 'creator' });
  const owner2 = await joinAs(p2, { ...creds.creator2, as: 'creator' });
  for (const [c, secret] of [[owner1, SECRET1], [owner2, SECRET2]]) {
    const r = await c.ask({ type: 'project.op', projectId: DOC, opId: 'op-init', session: 's-owner', ops: [{ op: 'set', path: '', value: { id: DOC, name: 'init', marker: secret, tracks: [] } }] });
    if (r.type !== 'project.op.ok') throw new Error(`放项目内容失败：${JSON.stringify(r)}`);
  }
  const revOf = async (c) => (await stateOf(c)).rev;
  const textOf = async (c) => JSON.stringify(await stateOf(c));

  const jia = await joinAs(p1, creds.jia);
  const yi = await joinAs(p2, creds.yi);
  const bing1 = await joinAs(p1, creds.bing);
  const bingDevice = bing1.device;
  const bing2 = await joinAs(p2, { ...creds.bing, device: bingDevice });
  const ding = await joinAs(p1, creds.ding);

  // 假 Agent 服务：真私钥、真握手、真控制连接
  const agent = createServiceClient({ base: BASE, key: readServiceKeyFile(secretsDir.agent) });
  await agent.ready();
  const secrets = new Set();
  const note = (t) => { if (typeof t === 'string' && t.length > 20) secrets.add(t); return t; };
  const grantFor = async (page, cid) => note((await delegationOf(page, cid)).ticket);
  const shortFor = async (page) => note((await delegationOf(page)).ticket);
  /** 换票据并开数据连接；回 `{ conn, ticket, reply }`，换不出时 `conn` 是 null */
  const openAgent = async (projectId, grant, cid, n = 1, extra = {}) => {
    const reply = await agent.memberTicket({ projectId, conversation: n, conversationId: cid, delegation: grant, ...extra });
    if (!reply.ok) return { conn: null, reply };
    note(reply.ticket);
    const conn = wsOpen(agent.dataProtocols(reply.ticket));
    return { conn: (await conn.opened) ? conn : null, reply, ticket: reply.ticket };
  };

  const gJia = await grantFor(jia, 'conv-jia');
  const gBing1 = await grantFor(bing1, 'conv-bing-1');
  const gBing2 = await grantFor(bing2, 'conv-bing-2');
  const gDing = await grantFor(ding, 'conv-ding');
  const aJia = await openAgent(p1.projectId, gJia, 'conv-jia');
  const aBing1 = await openAgent(p1.projectId, gBing1, 'conv-bing-1', 2);
  const aBing2 = await openAgent(p2.projectId, gBing2, 'conv-bing-2');
  const aDing = await openAgent(p1.projectId, gDing, 'conv-ding', 3);
  if (!aJia.conn || !aBing1.conn || !aBing2.conn || !aDing.conn) throw new Error('Agent 的数据连接没建成');

  // ---------- P1 读不到
  {
    const cross = await agent.memberTicket({ projectId: p2.projectId, conversation: 1, conversationId: 'conv-jia', delegation: gJia });
    const seen = await textOf(aJia.conn);
    const direct = await joinAs(p2, creds.jia);
    check('P1 成员甲的对话读不到成员乙的项目', cross.ok === false && cross.reason === 'project' && seen.includes(SECRET1) && !seen.includes(SECRET2) && direct === null, {
      crossTicket: cross.ok ? 'issued' : cross.reason, readsOwnProject: seen.includes(SECRET1), seesOtherProject: seen.includes(SECRET2), jiaJoinsProjectTwo: direct !== null,
    });
    direct?.close();
  }

  // ---------- P2 改不了
  {
    const before2 = await stateOf(owner2);
    const w = await aJia.conn.ask(opOf('op-jia-1', 'changed-by-jia-agent'));
    // 消息里自报别的项目、别的成员：不认（空间只由连接的身份定）
    const w2 = await aJia.conn.ask({ ...opOf('op-jia-2', 'still-project-one'), tenantId: p2.projectId, space: p2.projectId, userId: yi.userId });
    const after1 = await stateOf(owner1);
    const after2 = await stateOf(owner2);
    check('P2 成员甲的对话改不了成员乙的项目', w.type === 'project.op.ok' && w2.type === 'project.op.ok' && after1.rev === w2.rev && after2.rev === before2.rev && JSON.stringify(after2).includes(SECRET2)
      && !JSON.stringify(after2).includes('changed-by-jia-agent') && !JSON.stringify(after2).includes('still-project-one'), {
      projectOneRev: after1.rev, projectTwoRevBefore: before2.rev, projectTwoRevAfter: after2.rev,
    });
  }

  // ---------- P3 一个项目的对话拿不到另一个项目的内容（丙两个项目都有权限）
  {
    const seen1 = await textOf(aBing1.conn);
    const seen2 = await textOf(aBing2.conn);
    const swap = await agent.memberTicket({ projectId: p2.projectId, conversation: 2, conversationId: 'conv-bing-1', delegation: gBing1 });
    const swapCid = await agent.memberTicket({ projectId: p1.projectId, conversation: 2, conversationId: 'conv-bing-2', delegation: gBing1 });
    const lied = await agent.memberTicket({ projectId: p1.projectId, conversation: 2, conversationId: 'conv-bing-1', delegation: gBing1, userId: jia.userId, username: 'jia', u: jia.userId, access: 'rw' });
    const got = await aBing1.conn.ask({ type: 'content.list', kind: 'card-source' });
    check('P3 一个项目的对话拿不到另一个项目的内容', seen1.includes(SECRET1) && !seen1.includes(SECRET2) && seen2.includes(SECRET2) && !seen2.includes(SECRET1)
      && swap.reason === 'project' && swapCid.reason === 'conversation' && lied.ok === true && lied.userId === bing1.userId && verdict(got) === 'error:forbidden', {
      projectOneConvSeesTwo: seen1.includes(SECRET2), projectTwoConvSeesOne: seen2.includes(SECRET1), grantOneForProjectTwo: swap.reason ?? 'issued',
      grantForOtherConversation: swapCid.reason ?? 'issued', selfReportedUserIgnored: lied.userId === bing1.userId, contentList: verdict(got),
    });
  }

  // ---------- P4 素材
  {
    const rw = await owner2.ask({ type: 'auth.ticket', kind: 'asset', access: 'rw' });
    const bytes = randomBytes(512);
    const hash = createHash('sha256').update(bytes).digest('hex');
    const auth = (t) => ({ Authorization: `Bearer ${t}` });
    const put = await fetch(`${ASSET}/media/${hash}/0`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), ...auth(rw.ticket) } });
    const done = await fetch(`${ASSET}/media/${hash}/complete`, { method: 'POST', headers: auth(rw.ticket) });
    const read = async (t) => (await fetch(`${ASSET}/media/${hash}`, { headers: auth(t) })).status;
    const asked = [];
    for (const c of [aBing1.conn, aBing2.conn, aJia.conn]) for (const access of ['r', 'rw']) asked.push(verdict(await c.ask({ type: 'auth.ticket', kind: 'asset', access })));
    const statuses = {
      memberOwnTicket: await read(rw.ticket),
      grantOfOtherProject: await read(gBing1), grantOfThisProject: await read(gBing2), shortDelegation: await read(await shortFor(bing2)),
      agentConnTicketOtherProject: await read(aBing1.ticket), agentConnTicketThisProject: await read(aBing2.ticket), noTicket: (await fetch(`${ASSET}/media/${hash}`)).status,
    };
    const write = await fetch(`${ASSET}/snap/${hash}/0`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), ...auth(aBing2.ticket) } });
    check('P4 一个项目的对话拿不到另一个项目的素材（也取不到素材票据）', put.status === 200 && done.status === 200 && asked.every((v) => v === 'error:forbidden') && statuses.memberOwnTicket === 200
      && Object.entries(statuses).every(([k, v]) => (k === 'memberOwnTicket' ? v === 200 : v === 401)) && write.status === 401, { assetTicketRequests: asked, statuses, writeWithAgentTicket: write.status });
  }

  // ---------- P5 对话记录的归属
  {
    const v1 = await agent.verifyDelegation(await shortFor(bing1));
    const v2 = await agent.verifyDelegation(await shortFor(bing2));
    const vJia = await agent.verifyDelegation(gJia);
    const vOwner = await agent.verifyDelegation(await shortFor(owner1));
    check('P5 对话记录的归属字段只取自委托', v1.ok && v2.ok && vJia.ok && vOwner.ok && v1.projectId === p1.projectId && v2.projectId === p2.projectId && v1.ownerKey === 'user:bing' && v2.ownerKey === 'user:bing'
      && vJia.projectId === p1.projectId && vJia.ownerKey === 'user:jia' && vJia.conversationId === 'conv-jia' && vOwner.ownerKey === 'creator', {
      bingInOne: { projectId: v1.projectId === p1.projectId, ownerKey: v1.ownerKey }, bingInTwo: { projectId: v2.projectId === p2.projectId, ownerKey: v2.ownerKey },
      jia: { ownerKey: vJia.ownerKey, conversationId: vJia.conversationId }, creator: vOwner.ownerKey,
    });
  }

  // ---------- P6 伪造
  {
    // 改签名段的第一个字符：改完仍是合规的 base64url（改最后一个字符有十六分之一的机会变成不合规，原因就成了 format）
    const flip = (t) => { const i = t.lastIndexOf('.') + 1; return t.slice(0, i) + (t[i] === 'A' ? 'B' : 'A') + t.slice(i + 1); };
    const tamper = (t, patch) => {
      const [v, seg, sig] = t.split('.');
      const body = { ...JSON.parse(Buffer.from(seg, 'base64url').toString('utf8')), ...patch };
      return `${v}.${Buffer.from(JSON.stringify(body), 'utf8').toString('base64url')}.${sig}`;
    };
    const real = readRecord(p1.projectId);
    const selfSigned = signDelegation({ ...real, ticketKey: randomBytes(32).toString('base64url') }, { u: jia.userId, aud: 'agent', acc: 'rw', cid: 'conv-jia' }, Date.now()).ticket;
    const otherProjectKey = signDelegation({ ...real, ticketKey: readRecord(p2.projectId).ticketKey }, { u: jia.userId, aud: 'agent', acc: 'rw', cid: 'conv-jia' }, Date.now()).ticket;
    const connTicket = (await jia.ask({ type: 'auth.ticket', kind: 'conn', role: 'agent', conversation: 1 })).ticket;
    const assetTicket = (await jia.ask({ type: 'auth.ticket', kind: 'asset', access: 'rw' })).ticket;
    const cases = {
      签名改一个字符: flip(gJia), 把只读改成读写: tamper(gDing, { acc: 'rw' }), 把成员改成乙: tamper(gJia, { u: yi.userId }), 把项目改成项目二: tamper(gJia, { p: p2.projectId }),
      把有效期改长: tamper(gJia, { exp: Date.now() + 86_400_000 }), 自己造密钥签: selfSigned, 用项目二的密钥签项目一的: otherProjectKey,
      成员自己的连接票据冒充: connTicket, 素材票据冒充: assetTicket, 乱写: 'v1.aaaa.bbbb',
    };
    const out = {};
    let ok = true;
    for (const [what, t] of Object.entries(cases)) {
      const v = await agent.verifyDelegation(t);
      const s = await agent.memberTicket({ projectId: p1.projectId, conversation: 1, conversationId: 'conv-jia', delegation: t });
      out[what] = { verify: v.ok ? 'accepted' : v.reason, ticket: s.ok ? 'issued' : s.reason };
      if (v.ok || s.ok) ok = false;
    }
    const hs = wsOpen(ticketProtocols(gJia));
    const asHandshake = await hs.opened;
    hs.close();
    check('P6 伪造的成员身份证明被拒', ok && asHandshake === false, { cases: out, delegationAsHandshakeTicket: asHandshake ? 'accepted' : 'refused' });
  }

  // ---------- P7 过期
  {
    const real = readRecord(p1.projectId);
    const at = Date.now();
    const expiredShort = signDelegation(real, { u: jia.userId, aud: 'agent', acc: 'rw' }, at - (2 * 60_000 + 31_000)).ticket;
    const expiredGrant = signDelegation(real, { u: jia.userId, aud: 'agent', acc: 'rw', cid: 'conv-jia' }, at - (60 * 60_000 + 31_000)).ticket;
    const liveGrant = signDelegation(real, { u: jia.userId, aud: 'agent', acc: 'rw', cid: 'conv-jia' }, at - 59 * 60_000).ticket;
    const a = await agent.verifyDelegation(expiredShort);
    const b = await agent.verifyDelegation(expiredGrant);
    const c = await agent.memberTicket({ projectId: p1.projectId, conversation: 1, conversationId: 'conv-jia', delegation: expiredGrant });
    const d = await agent.verifyDelegation(liveGrant);
    check('P7 过期的成员身份证明被拒', a.reason === 'expired' && b.reason === 'expired' && c.reason === 'expired' && d.ok === true, {
      shortAfter2m31s: a.ok ? 'accepted' : a.reason, grantAfter60m31s: b.ok ? 'accepted' : b.reason, ticketWithExpiredGrant: c.ok ? 'issued' : c.reason, grantAt59m: d.ok ? 'accepted' : d.reason,
    });
  }

  // ---------- P8 只读
  {
    const before = await revOf(owner1);
    const v = await agent.verifyDelegation(gDing);
    const read = await stateOf(aDing.conn);
    const w = await aDing.conn.ask(opOf('op-ding-1', 'changed-by-readonly'));
    const up = await aDing.conn.ask({ type: 'project.upload', projectId: DOC, uploadId: 'up-ding', index: 0, count: 1, data: JSON.stringify({ id: DOC, name: 'x', tracks: [] }) });
    const after = await stateOf(owner1);
    check('P8 只读成员发起的对话改不了项目', v.acc === 'r' && aDing.reply.access === 'r' && read.type === 'project.state' && verdict(w) === 'error:forbidden' && verdict(up) === 'error:forbidden'
      && after.rev === before && !JSON.stringify(after).includes('changed-by-readonly'), {
      delegationAcc: v.acc, ticketAccess: aDing.reply.access, read: read.type, op: verdict(w), upload: verdict(up), revBefore: before, revAfter: after.rev,
    });
  }

  // ---------- P9 白名单
  {
    const tries = {
      'auth.ticket conn': { type: 'auth.ticket', kind: 'conn', role: 'page' }, 'auth.ticket delegate': { type: 'auth.ticket', kind: 'delegate', audience: 'agent', conversation: 'conv-jia' },
      'shared.members': { type: 'shared.members' }, 'shared.challenge': { type: 'shared.challenge' }, 'shared.admin': { type: 'shared.admin', op: 'delete' },
      'node.hello': { type: 'node.hello', nodeId: 'x', profile: 'host' }, 'task.claim': { type: 'task.claim' }, 'publisher.hello': { type: 'publisher.hello', publisherId: 'x' },
      'task.publish': { type: 'task.publish', tasks: [] }, 'content.put': { type: 'content.put', kind: 'card-source', key: 'src/cards/user/x.card.tsx', body: { source: 'x' } },
      'content.get': { type: 'content.get', kind: 'card-source', key: 'x' }, 'project.snapshot.put': { type: 'project.snapshot.put', projectId: DOC },
      'project.announce': { type: 'project.announce', projectId: DOC }, 'service.announce': { type: 'service.announce' }, 'hosted.watch': { type: 'hosted.watch' },
      'hosted.ticket': { type: 'hosted.ticket', projectId: p2.projectId, purpose: 'publish' }, 'cost.put': { type: 'cost.put' },
    };
    const out = {};
    for (const [what, m] of Object.entries(tries)) out[what] = verdict(await aJia.conn.ask(m));
    check('P9 Agent 的连接发表外的消息一律 forbidden', Object.values(out).every((v) => v === 'error:forbidden'), { outcomes: out });
  }

  // ---------- P14 发布连接（放在撤销之前建好，撤销时看它受不受影响）
  const pubTicket = await agent.publishTicket(p1.projectId);
  note(pubTicket.ticket);
  const pub = wsOpen(agent.dataProtocols(pubTicket.ticket));
  await pub.opened;
  const p14 = {
    hello: verdict(await pub.ask({ type: 'publisher.hello', publisherId: `agent:probe-${tag}` })),
    clipPlan: verdict(await pub.ask({ type: 'task.publish', tasks: [clipsPlanTaskOf({ projectId: DOC, projectRev: 1, clips: ['clip-a', 'clip-b'], codeVersion: 'probe' })] })),
    wholePlan: verdict(await pub.ask({ type: 'task.publish', tasks: [{ id: `plan:${DOC}@1`, kind: 'plan', resultKey: `${DOC}@1`, range: null, source: { projectId: DOC, projectRev: 1 }, weight: { class: 'light' }, requires: {} }] })),
    read: verdict(await pub.ask({ type: 'project.open', projectId: DOC })),
    write: verdict(await pub.ask(opOf('op-pub-1', 'by-publish-conn'))),
    ticket: verdict(await pub.ask({ type: 'auth.ticket', kind: 'asset', access: 'r' })),
    nodeHello: verdict(await pub.ask({ type: 'node.hello', nodeId: 'x', profile: 'host' })),
    noDelegationNoPurpose: (await agent.serviceTicket(p1.projectId)).reason ?? 'issued',
  };

  // ---------- P10 关开关
  {
    // 对话「正在进行」：连续提交写入，直到连接被关
    let landed = 0;
    let lastOk = 0;
    let stop = false;
    const loop = (async () => {
      for (let i = 0; !stop; i += 1) {
        const r = await aJia.conn.ask(opOf(`op-run-${i}`, `run-${i}`), 3000);
        if (r.type === 'project.op.ok') { landed += 1; lastOk = performance.now(); } else if (r.reason === 'closed') break;
        await sleep(20);
      }
    })();
    await sleep(300);
    const landedBefore = landed;
    const t0 = performance.now();
    const off = await adminOp(owner1, p1, 'set-hosted-service', { service: 'agent', enabled: false });
    const closes = await Promise.all([aJia, aBing1, aDing].map((a) => Promise.race([a.conn.closed, sleep(2000).then(() => null)])));
    const pubClose = await Promise.race([pub.closed, sleep(2000).then(() => null)]);
    stop = true;
    await loop;
    const ms = closes[0] ? closes[0].at - t0 : null;
    const revAtClose = await revOf(owner1);
    await sleep(500);
    const revLater = await revOf(owner1);
    const swap = await agent.memberTicket({ projectId: p1.projectId, conversation: 1, conversationId: 'conv-jia', delegation: gJia });
    const ver = await agent.verifyDelegation(gJia);
    const fresh = await delegationOf(jia, 'conv-jia');
    const spare = wsOpen(agent.dataProtocols(aJia.ticket));
    const spareOpened = await spare.opened;
    spare.close();
    const other = verdict(await aBing2.conn.ask({ type: 'presence.list', projectId: DOC }));
    const memberStill = verdict(await jia.ask({ type: 'shared.members' }));
    check('P10 创建者关掉开关后正在进行的对话被停掉', off.type === 'shared.admin.ok' && landedBefore > 0 && closes.every((c) => c && c.code === 4003 && c.reason === 'service-disabled')
      && pubClose?.code === 4003 && ms !== null && ms < 2000 && revAtClose === revLater && swap.reason === 'service-disabled' && ver.reason === 'service-disabled'
      && verdict(fresh) === 'error:service-disabled' && spareOpened === false && other === 'presence.state' && memberStill === 'shared.members.list', {
      writesBeforeSwitch: landedBefore, closeMs: ms === null ? null : Math.round(ms * 10) / 10, lastWriteBeforeCloseMs: closes[0] ? Math.round((closes[0].at - lastOk) * 10) / 10 : null,
      closes: closes.map((c) => (c ? `${c.code} ${c.reason}` : 'still-open')), publishConn: pubClose ? `${pubClose.code} ${pubClose.reason}` : 'still-open',
      revAtClose, revHalfSecondLater: revLater, ticketWithOldGrant: swap.reason ?? 'issued', verifyOldGrant: ver.reason ?? 'accepted', newDelegation: verdict(fresh),
      oldConnTicketHandshake: spareOpened ? 'accepted' : 'refused', otherProjectConversation: other, memberOwnConnection: memberStill,
    });
    const on = await adminOp(owner1, p1, 'set-hosted-service', { service: 'agent', enabled: true });
    const back = await openAgent(p1.projectId, gJia, 'conv-jia');
    check('P10b 开关开回来后恢复', on.type === 'shared.admin.ok' && !!back.conn && (await back.conn.ask(opOf('op-back-1', 'back'))).type === 'project.op.ok', { reopened: !!back.conn });
    aJia.conn = back.conn;
    aJia.ticket = back.ticket;
  }

  // 撤销之前把连接重新建好；这回发起成员都离线（页面连接关掉）
  const gBing1b = await grantFor(bing1, 'conv-bing-1');
  const gDingb = await grantFor(ding, 'conv-ding');
  const bBing1 = await openAgent(p1.projectId, gBing1b, 'conv-bing-1', 2);
  const bDing = await openAgent(p1.projectId, gDingb, 'conv-ding', 3);
  const pub2Ticket = await agent.publishTicket(p1.projectId);
  note(pub2Ticket.ticket);
  const pub2 = wsOpen(agent.dataProtocols(pub2Ticket.ticket));
  await pub2.opened;
  for (const page of [jia, bing1, ding]) page.close();
  await sleep(300);
  const online = (await owner1.ask({ type: 'shared.members' })).devices ?? [];
  const pagesOffline = online.every((d) => d.tags.editing === false || d.username === creds.creator1.username);

  // ---------- P17 地址下发（真的托管组合进程读环境变量）
  {
    const hosted = (await owner1.ask({ type: 'shared.members' })).hosted ?? {};
    check('P17 Agent 服务的对外地址由托管端配置下发', hosted.agent?.available === true && hosted.agent?.enabled === true && hosted.agent?.url === AGENT_URL && hosted.render?.url === undefined, {
      agent: hosted.agent ?? null, render: hosted.render ?? null,
    });
  }

  // ---------- P16 发起成员离线后，对话委托继续有效
  {
    // 甲的页面已经断开；把他现有的 Agent 连接也关掉，从零开始：手里只剩那张对话委托
    aJia.conn.close();
    await aJia.conn.closed;
    await sleep(200);
    const rowsBefore = (await owner1.ask({ type: 'shared.members' })).devices ?? [];
    const jiaGone = !rowsBefore.some((d) => d.username === 'jia');
    const revBefore = await revOf(owner1);
    const t0 = performance.now();
    const again = await openAgent(p1.projectId, gJia, 'conv-jia', 5);
    const exchangeMs = performance.now() - t0;
    const w = again.conn ? await again.conn.ask({ ...opOf('op-offline-1', 'written-while-offline'), session: 's-offline' }) : { type: 'error', reason: 'no-conn' };
    const seen = await owner1.next((m) => m.type === 'project.ops' && m.opId === 'op-offline-1', 3000);
    const after = await stateOf(owner1);
    const rows = (await owner1.ask({ type: 'shared.members' })).devices ?? [];
    const row = rows.find((d) => d.username === 'jia');
    const actor = seen.actor ?? null;
    check('P16 发起成员离线后凭对话委托仍能换票据并提交编辑', pagesOffline && jiaGone && again.reply.ok === true && !!again.conn && w.type === 'project.op.ok' && after.rev === revBefore + 1
      && JSON.stringify(after).includes('written-while-offline') && actor?.userId === jia.userId && actor?.role === 'agent' && actor?.service === 'agent' && actor?.conversation === 5
      && !!row && row.tags.editing === false && row.tags.agents === 1 && JSON.stringify(row.conns) === JSON.stringify([{ role: 'agent', conversation: 5, service: 'agent' }])
      && !rows.some((d) => 'service' in d), {
      memberPagesOnline: !pagesOffline, memberHadNoConnection: jiaGone, ticket: again.reply.ok ? 'issued' : again.reply.reason, op: verdict(w), revBefore, revAfter: after.rev,
      actor: actor ? { isMember: actor.userId === jia.userId, role: actor.role, service: actor.service ?? null, conversation: actor.conversation } : null,
      memberRow: row ? { tags: row.tags, conns: row.conns } : null, exchangeAndConnectMs: Math.round(exchangeMs * 10) / 10,
    });
    if (again.conn) { aJia.conn = again.conn; aJia.ticket = again.ticket; }
  }

  // ---------- P11 踢人
  {
    const t0 = performance.now();
    const r = await adminOp(owner1, p1, 'kick', { username: 'bing', deviceId: bingDevice.deviceId });
    const c = await Promise.race([bBing1.conn.closed, sleep(2000).then(() => null)]);
    const swap = await agent.memberTicket({ projectId: p1.projectId, conversation: 2, conversationId: 'conv-bing-1', delegation: gBing1b });
    const ver = await agent.verifyDelegation(gBing1b);
    const spare = wsOpen(agent.dataProtocols(bBing1.ticket));
    const spareOpened = await spare.opened;
    spare.close();
    const inTwo = verdict(await aBing2.conn.ask({ type: 'presence.list', projectId: DOC }));
    const jiaStill = verdict(await aJia.conn.ask({ type: 'presence.list', projectId: DOC }));
    check('P11 成员被踢后对话被停掉（发起成员不在线）', r.type === 'shared.admin.ok' && pagesOffline && c?.code === 4003 && c.reason === 'kicked' && c.at - t0 < 2000 && swap.ok === false && ver.ok === false
      && spareOpened === false && inTwo === 'presence.state' && jiaStill === 'presence.state', {
      membersOffline: pagesOffline, close: c ? `${c.code} ${c.reason}` : 'still-open', closeMs: c ? Math.round((c.at - t0) * 10) / 10 : null,
      ticketWithOldGrant: swap.reason ?? 'issued', verifyOldGrant: ver.reason ?? 'accepted', oldConnTicketHandshake: spareOpened ? 'accepted' : 'refused',
      sameMemberOtherProject: inTwo, otherMemberSameProject: jiaStill,
    });
  }

  // ---------- P12 移出名单
  {
    const t0 = performance.now();
    const r = await adminOp(owner1, p1, 'set-list', { list: [{ username: 'ding', keep: true }, { username: 'bing', keep: true }] });
    const c = await Promise.race([aJia.conn.closed, sleep(2000).then(() => null)]);
    const swap = await agent.memberTicket({ projectId: p1.projectId, conversation: 1, conversationId: 'conv-jia', delegation: gJia });
    const ver = await agent.verifyDelegation(gJia);
    const dingStill = verdict(await bDing.conn.ask({ type: 'presence.list', projectId: DOC }));
    check('P12 成员被移出名单后对话被停掉', r.type === 'shared.admin.ok' && c?.code === 4003 && c.reason === 'removed' && c.at - t0 < 2000 && swap.ok === false && ver.ok === false && dingStill === 'presence.state', {
      close: c ? `${c.code} ${c.reason}` : 'still-open', closeMs: c ? Math.round((c.at - t0) * 10) / 10 : null, ticketWithOldGrant: swap.reason ?? 'issued',
      verifyOldGrant: ver.reason ?? 'accepted', memberStillListed: dingStill,
    });
  }

  // ---------- P14 结论（踢人、移出之后发布连接还在）
  {
    const alive = verdict(await pub2.ask({ type: 'publisher.hello', publisherId: `agent:probe2-${tag}` }));
    check('P14 只用来发布补渲计划的连接', p14.hello === 'publisher.welcome' && p14.clipPlan === 'task.published' && p14.wholePlan === 'error:forbidden' && p14.read === 'error:forbidden'
      && p14.write === 'error:forbidden' && p14.ticket === 'error:forbidden' && p14.nodeHello === 'error:forbidden' && p14.noDelegationNoPurpose === 'forbidden' && alive === 'publisher.welcome', {
      ...p14, afterKickAndRemoval: alive,
    });
  }

  // ---------- P13 删项目
  {
    const t0 = performance.now();
    const r = await adminOp(owner1, p1, 'delete');
    const c = await Promise.race([bDing.conn.closed, sleep(2000).then(() => null)]);
    const cp = await Promise.race([pub2.closed, sleep(2000).then(() => null)]);
    const swap = await agent.memberTicket({ projectId: p1.projectId, conversation: 3, conversationId: 'conv-ding', delegation: gDingb });
    const ver = await agent.verifyDelegation(gDingb);
    const pubAgain = await agent.publishTicket(p1.projectId);
    const two = verdict(await aBing2.conn.ask(opOf('op-two-1', 'project-two-alive')));
    check('P13 项目删除后对话被停掉', r.type === 'shared.admin.ok' && c?.code === 4004 && c.reason === 'deleted' && c.at - t0 < 2000 && cp?.code === 4004 && swap.reason === 'no-project' && ver.reason === 'no-project'
      && pubAgain.reason === 'no-project' && two === 'project.op.ok', {
      close: c ? `${c.code} ${c.reason}` : 'still-open', closeMs: c ? Math.round((c.at - t0) * 10) / 10 : null, publishConn: cp ? `${cp.code} ${cp.reason}` : 'still-open',
      ticketWithOldGrant: swap.reason ?? 'issued', verifyOldGrant: ver.reason ?? 'accepted', publishTicket: pubAgain.reason ?? 'issued', otherProjectStillWritable: two,
    });
  }

  // ---------- P15 日志
  {
    await sleep(200);
    const leaked = [...secrets].filter((s) => childLog.includes(s) || s.split('.').some((seg) => seg.length > 20 && childLog.includes(seg)));
    check('P15 托管组合的日志里没有委托、对话委托、票据的原文', leaked.length === 0 && secrets.size >= 10 && childLog.includes('hosted.ticket'), { secretsChecked: secrets.size, leaked: leaked.length, logBytes: childLog.length });
  }

  agent.close();
  for (const c of [owner1, owner2, yi, bing2, aBing2.conn]) c?.close();
}

let failed = false;
try {
  await main();
} catch (err) {
  failed = true;
  process.stdout.write(`${JSON.stringify({ check: '探针自身', ok: false, error: String(err?.message ?? err) })}\n`);
} finally {
  await stopHosted();
  if (!KEEP) {
    try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 留给系统清 */ }
  }
}
const bad = results.filter((r) => !r.ok);
process.stdout.write(`${JSON.stringify({ summary: { total: results.length, passed: results.length - bad.length, failed: bad.length + (failed ? 1 : 0), failedChecks: bad.map((r) => r.check) } })}\n`);
process.exit(bad.length > 0 || failed ? 1 : 0);
