#!/usr/bin/env node
/**
 * 云端 Agent 的「首支短片」验收探针(用户 2026-10-07 定;契约 `docs/plan/cloud-agent-contract.md` 第 22 节)。
 *
 * 要证明的事:**云端第一版,拿空对话里唯一的那句示例话,真能做出一支短片——只用内置卡,不建卡、不导入素材。**
 * 这句话是 `src/editor/right/chat/MessageList.tsx` 的 `EMPTY_EXAMPLE`(探针启动时从源码里读出来,与界面始终是同一句):
 *
 *     为我快速创建一个视频告诉我软件都可以做什么。
 *
 * 做法:对一个**空的云端项目**(两条空序列、没有素材、没有片段)发这一句,等这一轮收尾,读项目与事件记录,逐条判:
 *
 *   F1 这一轮正常收尾:对话状态 idle,事件里有 `end`,没有 `error` 事件;助手说了话(最后的回复不为空)。
 *   F2 项目里有若干片段(至少 3 个),每个都是卡片段、`cardId` 是仓库里的内置卡,项目没有自定义卡片定义、没有素材段。
 *   F3 时间轴连续:从头(≤ 1 秒)起,片段首尾衔接,没有一处空档超过 0.5 秒(多条序列的片段合起来看)。
 *   F4 总时长合理:片段结束的最晚时刻在 8～180 秒之间;项目时长字段与它相差不超过 1 秒(记作提示:不对不判红,
 *      系统提示词让它用 `set_project_meta` 修,没修只在输出里写一条 `note`)。
 *   F5 没有越界的工具调用:没有建卡与改卡(`create_card` `edit_card` `apply_card` `card_authoring_guide` `get_card_source`)、
 *      没有导入与采集素材(`import_media` `collect_*` `web_*`)、没有配音与识别、没有看画面,也没有任何不在云端开放清单里的工具
 *      (开放清单:`server/agent/service/cloud-tools.mjs`)。
 *   F6 没有因「云端暂不支持」做不下去:工具结果里出现「云端暂不支持」只记录(逐条列出,供调提示词),
 *      只有它出现之后项目仍不满足 F2、F3 才判红;出现过的工具结果失败(`ok:false`)也一并列出。
 *
 * 两种跑法:
 *
 *   1. 缺省(冒烟):本机隔离的整套——托管组合(文档 + 素材,本机信任关着)、Agent 服务(真进程,凭 keygen 生成的服务私钥)、
 *      仓库里的**模拟模型**(照消息里的脚本做,脚本只用内置卡、不建卡不导素材)。这只证明「从空项目到短片」这条链上
 *      云端开放的工具和落地都通、判定标准判得对;**不证明真实模型会这么做**。
 *
 *        node scripts/probes/cloud-agent-first-video-probe.mjs [--doc-port 8798] [--asset-port 8799] [--agent-port 5742]
 *
 *   2. 指向任意 Agent 服务与模型(真实模型验收,等新节点录入 Key 之后由主会话跑):
 *
 *        node scripts/probes/cloud-agent-first-video-probe.mjs --agent-url https://<节点>/agent --doc-base https://<节点>/<文档服务路径> \
 *            [--model <模型 id>] [--timeout-sec 900] [--keep-room]
 *
 *      探针在这台文档服务上**建一个测试房间**(限定进入,创建者与成员都是随机的测试凭证,不打印),放进空项目,以成员身份
 *      经 `--agent-url` 打 Agent 服务(`<agent-url>/v1/...`),只发上面那一句(原文,不带任何脚本);跑完删掉房间(`--keep-room` 留着)。
 *      不启动任何本机服务。生产节点上跑它是「只用测试房间与测试凭证,验完删掉」。
 *
 * 退出码:0 全过、1 有不过的、2 起不来或探针自己出错。输出:每条一行 JSON,最后一行是汇总 `{ ok, passed, failed, notes }`。
 * 令牌、口令、票据一概不打印。静默运行,结束时只结束自己起的进程、删掉自己的临时目录。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createSharedProject } from '../../server/auth/client.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import { CLOUD_OPEN_TOOLS } from '../../server/agent/service/cloud-tools.mjs';
import {
  KDF, waitFor, portBusy, startHosted, startAgent, joinAs, adminOp, projectOf, putProject, mockScript, agentApi, createChecks,
} from './cloud-agent-probe-lib.mjs';

const ROOT = path.resolve(fileURLToPath(import.meta.url), '..', '..', '..');

/* ------------------------------------------------------------------ 这句话:从界面源码里读,与界面同一句 */

export function firstVideoPrompt() {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'editor', 'right', 'chat', 'MessageList.tsx'), 'utf8');
  const m = /export const EMPTY_EXAMPLE = "([^"]+)";/.exec(src);
  if (!m) throw new Error('MessageList.tsx 里没找到 EMPTY_EXAMPLE');
  return m[1];
}

/* ------------------------------------------------------------------ 判定(纯函数,不碰网络) */

/** 仓库里的内置卡 id:`capabilities.json` 的键,加 `src/cards/native` 与 `src/cards/magicui` 各卡文件里顶层的 `id: "…"` */
export function builtinCardIds() {
  const ids = new Set(Object.keys(JSON.parse(fs.readFileSync(path.join(ROOT, 'src', 'cards', 'capabilities.json'), 'utf8'))));
  for (const dir of ['native', 'magicui']) {
    const d = path.join(ROOT, 'src', 'cards', dir);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!/\.(tsx|ts)$/.test(f)) continue;
      for (const m of fs.readFileSync(path.join(d, f), 'utf8').matchAll(/^ {2}id: ["']([a-z0-9][a-z0-9-]*)["'],?\s*$/gm)) ids.add(m[1]);
    }
  }
  return ids;
}

/** 绝不该出现的工具:建卡改卡、导入采集素材、配音识别、看画面(云端第一版都关着;名字在这里点出来,是为了报告写得明白) */
const FORBIDDEN_TOOL = /^(create_card|edit_card|apply_card|card_authoring_guide|get_card_source|inspect_card_dom|bake_card|import_media|collect_\w+|web_\w+|voice_\w+|sound_\w+|transcribe_media|detect_shots|see_frames|get_gif|text_editor|spawn_agent|auto_workflow)$/;

const clipsOf = (project) => (project?.tracks ?? []).flatMap((t) => (t.clips ?? []).map((c) => ({ ...c, trackId: t.id })));

/**
 * @param {{ project: object|null, events: object[], state?: string, builtin: Set<string>, openTools?: Set<string> }} input
 * @returns {{ checks: { check: string, ok: boolean, detail?: object }[], notes: string[], unsupported: object[] }}
 */
export function judgeFirstVideo({ project, events, state, builtin, openTools = CLOUD_OPEN_TOOLS }) {
  const checks = [];
  const notes = [];
  const add = (check, ok, detail = {}) => checks.push({ check, ok: !!ok, detail });

  const calls = events.filter((e) => e.type === 'tool_call');
  const results = events.filter((e) => e.type === 'tool_result');
  const errors = events.filter((e) => e.type === 'error');
  const said = events.filter((e) => e.type === 'text').map((e) => String(e.delta ?? e.text ?? '')).join('').trim();

  add('F1 这一轮正常收尾:idle、有 end、没有 error、助手说了话',
    state === 'idle' && events.some((e) => e.type === 'end') && errors.length === 0 && said.length > 0,
    { state, end: events.some((e) => e.type === 'end'), errors: errors.map((e) => ({ code: e.code, message: String(e.message ?? '').slice(0, 160) })), replyChars: said.length });

  const clips = clipsOf(project);
  const nonCard = clips.filter((c) => !c.cardId);
  const unknown = clips.filter((c) => c.cardId && !builtin.has(c.cardId));
  const userDefs = [...Object.keys(project?.cardDefinitions ?? {}), ...(project?.cardNodes ? Object.keys(project.cardNodes) : [])];
  const f2 = clips.length >= 3 && nonCard.length === 0 && unknown.length === 0 && userDefs.length === 0 && (project?.media ?? []).length === 0;
  add('F2 项目里有若干片段(≥ 3),都是内置卡,没有自定义卡定义、没有素材', f2, {
    clips: clips.length, cards: [...new Set(clips.map((c) => c.cardId).filter(Boolean))], mediaClips: nonCard.length, notBuiltin: unknown.map((c) => c.cardId), customDefinitions: userDefs.length, media: (project?.media ?? []).length,
  });

  const sorted = [...clips].filter((c) => Number.isFinite(c.start) && Number.isFinite(c.end)).sort((a, b) => a.start - b.start);
  let cursor = 0;
  let maxGap = 0;
  const first = sorted[0]?.start ?? Infinity;
  for (const c of sorted) {
    if (c.start > cursor) maxGap = Math.max(maxGap, c.start - cursor);
    cursor = Math.max(cursor, c.end);
  }
  const f3 = sorted.length >= 1 && first <= 1.0 && maxGap <= 0.5;
  add('F3 时间轴连续:≤ 1 秒起头,首尾衔接,空档不超过 0.5 秒', f3, { firstStart: Number.isFinite(first) ? first : null, maxGap: Number(maxGap.toFixed(3)), clips: sorted.length });

  const contentEnd = sorted.length ? Math.max(...sorted.map((c) => c.end)) : 0;
  add('F4 总时长合理:8～180 秒', contentEnd >= 8 && contentEnd <= 180, { contentEnd: Number(contentEnd.toFixed(2)), projectDuration: project?.duration ?? null });
  if (project && Math.abs((project.duration ?? 0) - contentEnd) > 1) notes.push(`项目时长字段 ${project.duration} 与片段结束的最晚时刻 ${contentEnd.toFixed(2)} 相差超过 1 秒(没用 set_project_meta 修)`);

  const bad = calls.filter((c) => FORBIDDEN_TOOL.test(String(c.name)) || !openTools.has(String(c.name)));
  add('F5 没有越界的工具调用:不建卡改卡、不导入采集素材、没有看画面,也没有开放清单之外的工具', bad.length === 0, { calls: calls.length, tools: [...new Set(calls.map((c) => c.name))], outOfBounds: [...new Set(bad.map((c) => c.name))] });

  const unsupported = results.filter((r) => /云端暂不支持/.test(String(r.summary ?? '')));
  const failed = results.filter((r) => r.ok === false && !unsupported.includes(r));
  for (const r of unsupported) notes.push(`工具回「云端暂不支持」:${r.name} —— ${String(r.summary).slice(0, 120)}`);
  for (const r of failed) notes.push(`工具失败:${r.name} —— ${String(r.summary ?? '').slice(0, 120)}`);
  add('F6 没有因「云端暂不支持」做不下去(出现过只记录;出现之后项目仍不满足 F2、F3 才判红)', unsupported.length === 0 || (f2 && f3), { unsupported: unsupported.map((r) => r.name), failedResults: failed.map((r) => r.name) });

  return { checks, notes, unsupported: unsupported.map((r) => ({ name: r.name, summary: r.summary })) };
}

/* ------------------------------------------------------------------ 自检:判定函数对「好的」与「坏的」都判得对 */

function selfTest(builtin) {
  const mk = (clips) => ({ tracks: [{ id: 't-1', clips }], media: [], duration: 20 });
  const good = mk([0, 5, 10, 15].map((s, i) => ({ id: `c${i}`, cardId: 'ring-metric', start: s, end: s + 5 })));
  const okEvents = [{ type: 'tool_call', name: 'add_clip' }, { type: 'tool_result', name: 'add_clip', ok: true }, { type: 'text', delta: '做好了' }, { type: 'end' }];
  const pass = judgeFirstVideo({ project: good, events: okEvents, state: 'idle', builtin }).checks.every((c) => c.ok);
  const gap = judgeFirstVideo({ project: mk([{ id: 'a', cardId: 'ring-metric', start: 0, end: 4 }, { id: 'b', cardId: 'ring-metric', start: 8, end: 12 }, { id: 'c', cardId: 'ring-metric', start: 12, end: 16 }]), events: okEvents, state: 'idle', builtin });
  const userCard = judgeFirstVideo({ project: mk([0, 5, 10].map((s, i) => ({ id: `c${i}`, cardId: i === 1 ? 'my-own-card' : 'ring-metric', start: s, end: s + 5 }))), events: okEvents, state: 'idle', builtin });
  const forbidden = judgeFirstVideo({ project: good, events: [...okEvents, { type: 'tool_call', name: 'create_card' }], state: 'idle', builtin });
  const blocked = judgeFirstVideo({ project: mk([]), events: [{ type: 'tool_call', name: 'add_clip' }, { type: 'tool_result', name: 'add_clip', ok: false, summary: '云端暂不支持 import_media' }, { type: 'text', delta: '做不了' }, { type: 'end' }], state: 'idle', builtin });
  const byName = (r, k) => r.checks.find((c) => c.check.startsWith(k));
  return pass
    && !byName(gap, 'F3').ok
    && !byName(userCard, 'F2').ok
    && !byName(forbidden, 'F5').ok
    && !byName(blocked, 'F6').ok;
}

/* ------------------------------------------------------------------ 探针本体 */

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };

async function main() {
  const { results: out, check } = createChecks();
  const PROMPT = firstVideoPrompt();
  const builtin = builtinCardIds();
  check('S0 判定函数自检:好的判过,空档、非内置卡、建卡调用、做不下去各判红', selfTest(builtin), { builtinCards: builtin.size });

  const external = args.includes('--agent-url');
  const model = argOf('--model', '');
  const timeoutMs = Number(argOf('--timeout-sec', external ? 900 : 90)) * 1000;
  const keepRoom = args.includes('--keep-room');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-firstvideo-'));
  let hosted = null;
  let agent = null;
  let base;
  let agentUrl;
  let owner = null;
  let member = null;
  let proj = null;

  try {
    if (external) {
      agentUrl = argOf('--agent-url', '').replace(/\/+$/, '');
      base = argOf('--doc-base', '');
      if (!agentUrl || !base) throw new Error('指向外部 Agent 服务时要同时给 --agent-url 与 --doc-base');
    } else {
      const DOC_PORT = Number(argOf('--doc-port', 8798));
      const ASSET_PORT = Number(argOf('--asset-port', 8799));
      const AGENT_PORT = Number(argOf('--agent-port', 5742));
      for (const [name, port] of [['文档服务', DOC_PORT], ['素材服务', ASSET_PORT], ['Agent 服务', AGENT_PORT]]) {
        if (await portBusy(port)) throw new Error(`端口 ${port}(${name})已被占用`);
      }
      const hostedData = path.join(tmp, 'hosted');
      const agentData = path.join(tmp, 'agent');
      const agentSecrets = path.join(tmp, 'agent-secrets');
      const gen = runKeygen(['--hosted-data', hostedData, '--secrets', agentSecrets, '--service', 'agent', '--instance-name', '云端 Agent(首支短片探针)']);
      if (gen?.ok === false) throw new Error('keygen 失败');
      hosted = await startHosted({ dataDir: hostedData, docPort: DOC_PORT, assetPort: ASSET_PORT });
      agent = await startAgent({ dataDir: agentData, secrets: agentSecrets, docPort: DOC_PORT, port: AGENT_PORT });
      base = `ws://127.0.0.1:${DOC_PORT}`;
      agentUrl = agent.url;
    }

    // 测试房间:限定进入,创建者与一位成员,凭证随机、不打印
    const pw = () => `pw-${randomBytes(8).toString('hex')}`;
    const creator = { username: `owner-${randomBytes(3).toString('hex')}`, password: pw() };
    const jia = { username: `jia-${randomBytes(3).toString('hex')}`, password: pw() };
    proj = { ...(await createSharedProject({ base, name: `first-video-${randomBytes(3).toString('hex')}`, mode: 'restricted', creator, list: [jia], kdf: KDF })), creator };
    owner = await joinAs(base, proj, { ...creator, as: 'creator' });
    member = await joinAs(base, proj, jia);
    if (!owner || !member) throw new Error('测试房间里的创建者或成员没进去');

    // 空的云端项目:两条空序列、没有素材、没有片段(与新建项目一样)
    const empty = { version: 1, id: proj.projectId, name: '首支短片', width: 1920, height: 1080, fps: 30, duration: 30, themeId: 'midnight', media: [], tracks: [{ id: 't-1', name: '序列 1', clips: [] }, { id: 't-2', name: '序列 2', clips: [] }], transitions: [] };
    await putProject(owner, proj.projectId, empty);

    const api = agentApi(agentUrl, member);
    const conv = `cc-firstvideo-${randomBytes(3).toString('hex')}`;
    const prompt = external ? PROMPT : `${PROMPT}\n${mockScript(smokeScript())}`;
    const sent = await api.send(conv, prompt, model ? { extra: { model } } : {});
    check('S1 发这一句回 202', sent.status === 202, { status: sent.status, code: sent.code ?? null });
    if (sent.status !== 202) throw new Error(`发消息没被接下:${sent.status} ${sent.code ?? ''}`);

    const ev = await api.events(conv, { ms: timeoutMs });
    const meta = await api.settled(conv, 30_000).catch(() => null);
    const final = await projectOf(owner, proj.projectId);
    const verdict = judgeFirstVideo({ project: final.project, events: ev.events, state: meta?.state, builtin });
    for (const c of verdict.checks) check(c.check, c.ok, c.detail);
    for (const n of verdict.notes) process.stdout.write(`${JSON.stringify({ note: n })}\n`);
    const tools = ev.events.filter((e) => e.type === 'tool_call').map((e) => e.name);
    process.stdout.write(`${JSON.stringify({ summary: { mode: external ? 'external' : 'smoke', model: model || null, toolCalls: tools.length, clips: clipsOf(final.project).length, contentEnd: Math.max(0, ...clipsOf(final.project).map((c) => c.end ?? 0)), events: ev.events.length, seconds: ev.events.length ? Math.round(((ev.events.at(-1)._at ?? 0) - (ev.events[0]._at ?? 0)) / 100) / 10 : null } })}\n`);
    return { out, notes: verdict.notes };
  } finally {
    member?.close();
    if (proj && owner && (external ? !keepRoom : true)) {
      try { await adminOp(owner, proj, 'delete'); } catch { /* 房间删不掉就留着,不影响结论 */ }
    }
    owner?.close();
    await agent?.stop();
    await hosted?.stop();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 临时目录删不掉不影响结论 */ }
  }
}

/** 冒烟用的模拟模型脚本:只用内置卡、不建卡、不导素材,从空项目排出 6 段首尾衔接的片段(模拟模型不读工具结果,所以都在第一条序列上) */
function smokeScript() {
  const cards = ['quote-lockup', 'stat-proof', 'step-timeline', 'ring-metric', 'versus-card', 'rank-bars'];
  return [
    { tool: 'get_project', input: {} },
    { tool: 'list_cards', input: {} },
    ...cards.map((cardId, i) => ({ tool: 'add_clip', input: { cardId, start: i * 4, duration: 4, trackId: 't-1' } })),
    { tool: 'set_project_meta', input: { duration: cards.length * 4 } },
    { say: '做好了一支 24 秒的短片:六张内置卡首尾衔接,依次展示引言、数据、步骤、环形指标、对比与排行。' },
  ];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(({ out, notes }) => {
    const failed = out.filter((r) => !r.ok);
    process.stdout.write(`${JSON.stringify({ ok: failed.length === 0, passed: out.length - failed.length, failed: failed.map((r) => r.check), notes: notes.length })}\n`);
    process.exit(failed.length ? 1 : 0);
  }, (err) => {
    process.stdout.write(`${JSON.stringify({ ok: false, error: String(err?.message ?? err).slice(0, 400) })}\n`);
    process.exit(2);
  });
}
