#!/usr/bin/env node
/**
 * 云端 Agent「声音」的端到端探针:音效合成、测响度、卡片声音(契约 `docs/plan/cloud-agent-contract.md` 第 9.4a～9.4c 节)。
 * 用断言,不靠推断。
 *
 *   node scripts/probes/cloud-agent-sound-probe.mjs [--doc-port 8798] [--asset-port 8799] [--agent-port 5745] [--render-port 5820]
 *        [--steps sound,readonly,measure,cardaudio,browser] [--desktop-port 5790] [--keep] [--verbose]
 *
 * 全部是真进程、真握手,只绑 127.0.0.1,数据在一个临时目录里,结束时删掉;不连任何远端,不向扬声器出声。模型是仓库里的模拟模型提供方。
 *   托管组合(文档 + 素材)、渲染服务(管理进程 + 常驻工作进程;带用户卡的项目另起隔离工作进程)、Agent 服务(`PROMPTCUT_AGENT_ASSET_URL`
 *   指到素材服务、`PROMPTCUT_AGENT_LOOK_URL` 指到渲染服务管理进程的口子)。端口同 `cloud-agent-look-probe.mjs`。
 *
 * # 验收标准(每条一行「过 / 不过」;stdout 最后一行是 JSON `{ ok, pass, fails, … }`;退出码 0 过、1 不过、2 起不来)
 *
 * S0 服务起来;Agent 服务配了素材服务(步骤里有 cardaudio 时另配看画面的口子,并起渲染服务)。
 * S1 音效合成(步骤 sound):云端 Agent 调 `sound_generate` 生成一段提示音(放在 1 秒处)与一段键盘声(复用打字机卡片的文字与节奏)。
 *    项目里多了两条带配方与内容哈希的音频素材、两个带配方的片段(提示音在 1 秒、键盘声在打字机卡片的起点);
 *    **别的成员**凭自己的素材票据从素材服务取得到这两份 WAV,取回的字节的哈希就是素材条目里的哈希;
 *    这两份 WAV 与本机用同一份配方合成的(`src/audio/soundGeneration.ts`,桌面版 Worker 里跑的那个函数)**逐字节相同**;
 *    同一个 requestId 重试不多出片段;`sound_status` 列得出作业;用量记录里有这两次合成(项目、成员、服务 `sound`、字节数)。
 * S2 只读成员(步骤 readonly):只读成员发起的对话里 `sound_generate` 与 `render_card_audio` 被拒(原因写明只读;这一次没起渲染服务时
 *    `render_card_audio` 根本没有交给模型),项目版本不变、素材表没有多出东西;`measure_audio` 照常能量(只读不写)。
 * S3 测响度(步骤 measure;要本机有 ffmpeg,没有时这一条写明跳过并算不过):`measure_audio` 量刚生成的提示音,回整体响度与峰值(有限的数);
 *    量时间轴回逐秒曲线并标出那一秒谁在出声;量完对话的工作目录里不留取来的素材。
 * S4 与真浏览器比(步骤 browser,最后做,这时三个服务已经停掉):起一台普通的编辑器开发服务器,在无头浏览器的页面里用**桌面版的入口**
 *    (`renderSoundEffectWavInWorker`,真的 Web Worker)按 S1 落进项目的两份配方各合成一次:内容哈希与云端入库的那两份相同。
 * S5 卡片声音(步骤 cardaudio):云端 Agent 用 `create_card` 建一张带 `audio()` 的声画用户卡(`fixtures/cloud-sound/sound-beep.tsx`,
 *    声音是一段只由参数与采样位置决定的正弦波)并放上时间轴,再 `render_card_audio`:片段多了 `cardAudio` 记录、素材表多了那份 WAV;
 *    成员从素材服务取回的 WAV 是 48000 Hz 的 32 位浮点、帧数等于片段时长,**逐样本**等于这张卡的公式算出来的值;
 *    这一次由渲染服务的**隔离工作进程**出(常驻工作进程没有为它多出一次),这张卡的声音代码**没有在 Agent 服务进程里执行**
 *    (代码里打的记号不在 Agent 服务的输出里);再调一次不重算(`reused: true`);`cancel_card_audio` 在没有在途任务时回 `cancelled: false`。
 */
import '../lib/no-user-dirs.mjs'; // 第一个 import:不继承外部的 PROMPTCUT_EXPORT_DIR / PROMPTCUT_DATA_DIR
import '../../src/testing/registerTs.mjs';
import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createSharedProject } from '../../server/auth/client.mjs';
import { runKeygen } from '../../server/hosted-render/keygen.mjs';
import { findAudioTools } from '../../server/agent/service/hosted-audio.mjs';
import { startDevServer } from '../lib/dev-server.mjs';
import { PROBE_CHROME_ARGS } from './probe-chrome.mjs';
import {
  ROOT, KDF, sleep, waitFor, portBusy, killTree, startProcess, startHosted, startAgent, joinAs, projectOf, putProject, mockScript, agentApi, createChecks,
} from './cloud-agent-probe-lib.mjs';

const args = process.argv.slice(2);
const argOf = (name, fallback) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : fallback; };
const ALL_STEPS = ['sound', 'readonly', 'measure', 'cardaudio', 'browser'];
const STEPS = String(argOf('--steps', ALL_STEPS.join(','))).split(',').map((s) => s.trim()).filter(Boolean);
const DOC_PORT = Number(argOf('--doc-port', 8798));
const ASSET_PORT = Number(argOf('--asset-port', 8799));
const AGENT_PORT = Number(argOf('--agent-port', 5745));
const RENDER_PORT = Number(argOf('--render-port', 5820));
const DESKTOP_PORT = Number(argOf('--desktop-port', 5790));
const KEEP = args.includes('--keep');
const VERBOSE = args.includes('--verbose');
const BASE = `ws://127.0.0.1:${DOC_PORT}`;
const AGENT_URL = `http://127.0.0.1:${AGENT_PORT}`;
const RENDER_STATUS = `http://127.0.0.1:${RENDER_PORT + 6}`;
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

const { results, check } = createChecks();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-ca-sound-'));
const D = { hosted: path.join(tmp, 'hosted'), agent: path.join(tmp, 'agent'), agentSecrets: path.join(tmp, 'agent-secrets'), render: path.join(tmp, 'render'), renderSecrets: path.join(tmp, 'render-secrets') };
let hosted = null;
let agent = null;
let render = null;
let desktop = null;
/** S1 落进项目的两份配方与云端入库的内容哈希(S4 拿去和真浏览器比) */
const made = [];

function startRender() {
  const env = {};
  for (const k of Object.keys(process.env)) if (/^PROMPTCUT_RENDER_/.test(k) && k !== 'PROMPTCUT_RENDER_SKIP_CHECKS') env[k] = undefined;
  render = startProcess(path.join(ROOT, 'server', 'hosted-render', 'main.mjs'), {
    ipc: true,
    env: {
      ...env,
      PROMPTCUT_RENDER_DOC_URL: BASE, PROMPTCUT_RENDER_SECRETS: D.renderSecrets, PROMPTCUT_RENDER_DATA: D.render,
      PROMPTCUT_RENDER_PORT: String(RENDER_PORT), PROMPTCUT_RENDER_ISO_PORT: String(RENDER_PORT + 3), PROMPTCUT_RENDER_STATUS_PORT: String(RENDER_PORT + 6),
      PROMPTCUT_RENDER_MAX_CONCURRENT: '2', PROMPTCUT_RENDER_SAMPLE_MS: '2000', PROMPTCUT_RENDER_MEM_LOW: '256M',
      PROMPTCUT_RENDER_EDITOR_DIR: path.join(tmp, 'no-editor'), PROMPTCUT_RENDER_AGENT_STATUS_URL: `${AGENT_URL}/healthz`,
      PROMPTCUT_RENDER_LOOK_SERVICES: path.join(D.hosted, 'secrets', 'services.json'),
      ...(VERBOSE ? { PROMPTCUT_RENDER_VERBOSE: '1' } : {}),
      ...(process.platform === 'win32' && !process.env.PROMPTCUT_TEST_ENV_FINGERPRINT ? { PROMPTCUT_TEST_ENV_FINGERPRINT: '7e57c10d00000002' } : {}),
    },
  });
  return render;
}
const renderStatus = async () => (await fetch(`${RENDER_STATUS}/status`, { signal: AbortSignal.timeout(5000) })).json();
const waitRenderReady = () => waitFor(async () => { const s = await renderStatus(); return s.directory?.connected && s.worker?.ready && s.queue ? s : null; }, 300_000, '渲染服务就绪', 1000);

/** Agent 服务盘上这个对话的工具结果事件(探针自己的临时目录) */
function toolResults(projectId, conversationId) {
  const root = path.join(D.agent, 'tenants', projectId);
  const stack = fs.existsSync(root) ? [root] : [];
  while (stack.length) {
    const dir = stack.pop();
    for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!item.isDirectory()) continue;
      const p = path.join(dir, item.name);
      if (item.name === conversationId && fs.existsSync(path.join(p, 'events.jsonl'))) {
        return fs.readFileSync(path.join(p, 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))
          .filter((e) => e.type === 'tool_result').map((e) => ({ name: e.name, ok: e.ok === true, summary: String(e.summary ?? '') }));
      }
      stack.push(p);
    }
  }
  return [];
}
const usageRows = () => {
  const dir = path.join(D.agent, 'usage');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })).filter(Boolean);
};
const toolsLine = (tools) => tools.map((t) => `${t.name}:${t.ok ? 'ok' : `不成 ${t.summary.slice(0, 200)}`}`);
const clipsOf = (p) => (p?.tracks ?? []).flatMap((t) => t.clips ?? []);

/** 以某位成员的素材票据从素材服务取一份素材 */
async function fetchMedia(member, hash) {
  const ticket = await member.ask({ type: 'auth.ticket', kind: 'asset', access: 'r' });
  const res = await fetch(`http://127.0.0.1:${ASSET_PORT}/api/asset/media/${hash}`, { headers: { authorization: `Bearer ${ticket.ticket}` }, signal: AbortSignal.timeout(15_000) });
  return res.status === 200 ? Buffer.from(await res.arrayBuffer()) : null;
}

/** S4:真浏览器里用桌面版的入口(Web Worker)按同一份配方合成,比内容哈希 */
async function browserStep() {
  if (!made.length) { check('S4 与真浏览器比:桌面版的入口(Web Worker)按同一份配方合成的 WAV 与云端入库的内容哈希相同', false, { reason: '前面没有生成出音效(要先跑步骤 sound)' }); return; }
  desktop = await startDevServer({
    port: DESKTOP_PORT, logFile: path.join(tmp, 'desktop-dev.log'),
    env: { PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_DATA_DIR: path.join(tmp, 'desktop-data'), PROMPTCUT_EXPORT_DIR: path.join(tmp, 'desktop-export'), PROMPTCUT_RENDER_BROKER: undefined, PROMPTCUT_RENDER_BROKER_KEY: undefined },
  });
  const { default: puppeteer } = await import('puppeteer');
  const browser = await puppeteer.launch({ headless: true, args: [...PROBE_CHROME_ARGS, '--mute-audio'] });
  let got = null;
  let version = null;
  try {
    version = await browser.version();
    const page = await browser.newPage();
    await page.goto(`${desktop.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
    got = await page.evaluate(async (recipes) => {
      const { renderSoundEffectWavInWorker } = await import('/src/audio/soundGenerationWorkerClient.ts');
      const out = [];
      for (const recipe of recipes) {
        const wav = await renderSoundEffectWavInWorker(recipe);
        const digest = await crypto.subtle.digest('SHA-256', wav);
        out.push({ worker: typeof Worker !== 'undefined', bytes: wav.byteLength, hash: [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('') });
      }
      return out;
    }, made.map((m) => m.recipe));
  } finally {
    await browser.close().catch(() => {});
  }
  check('S4 与真浏览器比:桌面版的入口(Web Worker)按同一份配方合成的 WAV 与云端入库的内容哈希相同', Array.isArray(got) && got.length === made.length
    && got.every((g, i) => g.worker === true && g.hash === made[i].hash && g.bytes === made[i].bytes), {
    browser: version, compared: made.map((m, i) => ({ preset: m.recipe.preset, cloud: `${m.hash.slice(0, 16)}… ${m.bytes} 字节`, browser: got?.[i] ? `${got[i].hash.slice(0, 16)}… ${got[i].bytes} 字节` : null, inWorker: got?.[i]?.worker ?? null, same: got?.[i]?.hash === m.hash })),
  });
}

async function main() {
  for (const s of STEPS) if (!ALL_STEPS.includes(s)) throw new Error(`不认识的步骤 ${s}`);
  for (const [name, port] of [['文档服务', DOC_PORT], ['素材服务', ASSET_PORT], ['Agent 服务', AGENT_PORT], ...[0, 1, 2, 3, 4, 5, 6].map((d) => ['渲染服务', RENDER_PORT + d])]) {
    if (await portBusy(port)) throw new Error(`端口 ${port}(${name})已被占用`);
  }
  runKeygen(['--hosted-data', D.hosted, '--secrets', D.renderSecrets, '--instance-name', '托管方的渲染节点(探针)']);
  runKeygen(['--hosted-data', D.hosted, '--secrets', D.agentSecrets, '--service', 'agent', '--instance-name', '云端 Agent(探针)']);
  const hostedEnv = { PROMPTCUT_AGENT_PUBLIC_URL: `${AGENT_URL}/v1` };
  hosted = await startHosted({ dataDir: D.hosted, docPort: DOC_PORT, assetPort: ASSET_PORT, env: hostedEnv });

  const pw = () => `pw-${randomBytes(6).toString('hex')}`;
  const creds = { alice: { username: 'alice', password: pw() }, rita: { username: 'rita', password: pw() }, ula: { username: 'ula', password: pw() } };
  const tag = randomBytes(4).toString('hex');
  const px = { ...(await createSharedProject({ base: BASE, name: `sound-x-${tag}`, mode: 'restricted', creator: creds.alice, list: [creds.rita], kdf: KDF })), creator: creds.alice };
  const py = { ...(await createSharedProject({ base: BASE, name: `sound-y-${tag}`, mode: 'restricted', creator: creds.ula, list: [], kdf: KDF })), creator: creds.ula };
  const X = px.projectId;
  const Y = py.projectId;
  // 只读成员:直接写项目记录(停进程、改文件、再起)
  await hosted.stop();
  {
    const file = path.join(D.hosted, 'docservice', 'auth', 'projects', `${X}.json`);
    const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
    rec.readonly = ['rita'];
    fs.writeFileSync(file, `${JSON.stringify(rec, null, 2)}\n`);
  }
  hosted = await startHosted({ dataDir: D.hosted, docPort: DOC_PORT, assetPort: ASSET_PORT, env: hostedEnv });

  const base = (id, name, duration, tracks) => ({
    version: 1, id, name, width: 1920, height: 1080, fps: 30, duration, themeId: 'dark', camera3dFov: 50,
    media: [], filters: [], pixelMaps: [], audioFx: [], cardNodes: [], style: {}, transitions: [], tracks,
  });
  const typing = { id: 'clip-typing', kind: 'card', cardId: 'mu-typing', start: 0.5, end: 4, params: { text: '云端的键盘声,ok!', duration: 80, delayMs: 100, seed: 5 } };
  const alice = await joinAs(BASE, px, { ...creds.alice, as: 'creator' });
  const rita = await joinAs(BASE, px, creds.rita);
  const ula = await joinAs(BASE, py, { ...creds.ula, as: 'creator' });
  await putProject(alice, X, base(X, '声音探针·音效', 6, [{ id: 'tr-0', name: 'tr-0', hidden: false, clips: [typing] }]));
  await putProject(ula, Y, base(Y, '声音探针·卡片声音', 3, [{ id: 'tr-0', name: 'tr-0', hidden: false, clips: [] }]));

  const needRender = STEPS.includes('cardaudio');
  if (needRender) startRender();
  agent = await startAgent({
    dataDir: D.agent, secrets: D.agentSecrets, docPort: DOC_PORT, port: AGENT_PORT,
    env: { PROMPTCUT_AGENT_ASSET_URL: `http://127.0.0.1:${ASSET_PORT}`, ...(needRender ? { PROMPTCUT_AGENT_LOOK_URL: RENDER_STATUS } : {}) },
  });
  if (needRender) await waitRenderReady();
  const health = await (await fetch(`${AGENT_URL}/healthz`)).json();
  const ready = agent.ready ?? {};
  check('S0 服务起来;Agent 服务配了素材服务' + (needRender ? '与看画面的口子' : ''), health.ok === true && ready.assetService === true && (!needRender || health.look === true), { assetService: ready.assetService ?? null, look: health.look ?? null });

  const run = async (page, projectId, conversationId, steps, { ms = 300_000, creativity } = {}) => {
    const api = agentApi(AGENT_URL, page);
    const sent = await api.send(conversationId, mockScript(steps), { extra: creativity ? { creativity } : {} });
    if (sent.status !== 202) return { sent, tools: [], meta: null, ms: 0 };
    const t0 = Date.now();
    const meta = await api.settled(conversationId, ms).catch(() => null);
    await sleep(300);
    return { sent, tools: toolResults(projectId, conversationId), meta, ms: Date.now() - t0 };
  };

  if (STEPS.includes('sound')) {
    const r = await run(alice, X, 'snd-make', [
      { tool: 'sound_presets', input: {} },
      { tool: 'sound_generate', input: { preset: 'notification', start: 1, requestId: 'probe-chime', name: '探针提示音', params: { frequency: 660, notes: [0, 4, 7] } } },
      { tool: 'sound_generate', input: { preset: 'keyboard', sourceClipId: 'clip-typing', requestId: 'probe-keys', name: '探针键盘声' } },
      { tool: 'sound_generate', input: { preset: 'notification', start: 1, requestId: 'probe-chime', name: '探针提示音', params: { frequency: 660, notes: [0, 4, 7] } } },
      { tool: 'sound_status', input: {} },
      { say: '音效做好了' },
    ]);
    const p = (await projectOf(alice, X)).project;
    const sounds = (p.media ?? []).filter((m) => m.kind === 'audio' && m.soundEffect?.recipe);
    const chime = sounds.find((m) => m.soundEffect.recipe.preset === 'notification');
    const keys = sounds.find((m) => m.soundEffect.recipe.preset === 'keyboard');
    const soundClips = clipsOf(p).filter((c) => c.soundEffect);
    const chimeClip = soundClips.find((c) => c.mediaId === chime?.id);
    const keysClip = soundClips.find((c) => c.mediaId === keys?.id);
    // 别的成员(只读的 rita)凭自己的素材票据取
    const got = { chime: chime ? await fetchMedia(rita, chime.hash) : null, keys: keys ? await fetchMedia(rita, keys.hash) : null };
    // 本机用同一份配方合成(桌面版 Worker 里跑的那个函数)
    const { renderSoundEffectWav } = await import('../../src/audio/soundGeneration.ts');
    const local = {
      chime: chime ? Buffer.from(await renderSoundEffectWav(structuredClone(chime.soundEffect.recipe))) : null,
      keys: keys ? Buffer.from(await renderSoundEffectWav(structuredClone(keys.soundEffect.recipe))) : null,
    };
    if (chime && got.chime) made.push({ recipe: chime.soundEffect.recipe, hash: chime.hash, bytes: got.chime.length });
    if (keys && got.keys) made.push({ recipe: keys.soundEffect.recipe, hash: keys.hash, bytes: got.keys.length });
    const rows = usageRows().filter((u) => u.kind === 'service' && u.service === 'sound' && u.projectId === X);
    const gens = r.tools.filter((t) => t.name === 'sound_generate');
    check('S1 音效合成:提示音与键盘声生成并入库,别的成员从素材服务取得到;WAV 与本机同配方合成的逐字节相同;项目里多了对应的素材与片段;重试不多出片段;记了用量', r.sent.status === 202 && r.meta?.state === 'idle'
      && gens.length === 3 && gens.every((t) => t.ok) && r.tools.find((t) => t.name === 'sound_status')?.ok === true
      && sounds.length === 2 && soundClips.length === 2 && !!chimeClip && chimeClip.start === 1 && chimeClip.soundEffect.requestId === 'probe-chime'
      && !!keysClip && keysClip.start === typing.start && keysClip.soundEffect.sourceClipId === 'clip-typing' && keys.soundEffect.recipe.events.length >= 8
      && !!got.chime && !!got.keys && sha256(got.chime) === chime.hash && sha256(got.keys) === keys.hash
      && got.chime.equals(local.chime) && got.keys.equals(local.keys)
      && rows.length === 2 && rows.every((u) => u.ok === true && u.unit === 'bytes' && u.username === 'alice') && rows.map((u) => u.units).sort().join() === [got.chime.length, got.keys.length].sort().join(), {
      end: r.meta?.state ?? null, ms: r.ms, tools: toolsLine(r.tools),
      media: sounds.map((m) => ({ name: m.name, preset: m.soundEffect.recipe.preset, hash: `${m.hash.slice(0, 16)}…`, bytes: m.size, seconds: +m.duration.toFixed(3) })),
      clips: soundClips.map((c) => ({ start: c.start, end: +c.end.toFixed(3), requestId: c.soundEffect.requestId, source: c.soundEffect.sourceClipId ?? null })),
      fetchedByOtherMember: { chime: got.chime?.length ?? null, keys: got.keys?.length ?? null, hashMatches: [!!got.chime && sha256(got.chime) === chime?.hash, !!got.keys && sha256(got.keys) === keys?.hash] },
      sameAsLocalSynthesis: { chime: !!got.chime && !!local.chime && got.chime.equals(local.chime), keys: !!got.keys && !!local.keys && got.keys.equals(local.keys) },
      usageRows: rows.map((u) => ({ service: u.service, model: u.model, units: u.units, unit: u.unit, ok: u.ok, member: u.username })),
    });
  }

  if (STEPS.includes('readonly')) {
    const before = await projectOf(alice, X);
    const r = await run(rita, X, 'snd-readonly', [
      { tool: 'sound_generate', input: { preset: 'notification', start: 2, requestId: 'ro-chime' } },
      { tool: 'render_card_audio', input: { clipId: 'clip-typing' } },
      { tool: 'measure_audio', input: { scope: 'timeline' } },
      { say: '只读成员试过了' },
    ]);
    const after = await projectOf(alice, X);
    const by = Object.fromEntries(r.tools.map((t) => [t.name, t]));
    const hasFfmpeg = !!findAudioTools();
    const hasSound = (before.project.media ?? []).some((m) => m.kind === 'audio');
    check('S2 只读成员:sound_generate 与 render_card_audio 被拒(写明只读),项目版本与素材表不变;measure_audio 照常能量', r.sent.status === 202 && r.meta?.state === 'idle'
      && by.sound_generate?.ok === false && /只读/.test(by.sound_generate.summary) && by.render_card_audio?.ok === false && (needRender ? /只读/ : /未知工具/).test(by.render_card_audio.summary)
      && after.rev === before.rev && (after.project.media ?? []).length === (before.project.media ?? []).length
      && (hasFfmpeg && hasSound ? by.measure_audio?.ok === true : true), {
      tools: toolsLine(r.tools), rev: [before.rev, after.rev], media: [(before.project.media ?? []).length, (after.project.media ?? []).length],
      measure: hasFfmpeg && hasSound ? '量了' : `没有断言(${hasFfmpeg ? '项目里还没有声音' : '本机没有 ffmpeg'})`,
    });
  }

  if (STEPS.includes('measure')) {
    const hasFfmpeg = !!findAudioTools();
    const p = (await projectOf(alice, X)).project;
    const chime = (p.media ?? []).find((m) => m.soundEffect?.recipe?.preset === 'notification');
    if (!hasFfmpeg || !chime) {
      check('S3 测响度:量刚生成的提示音与整条时间轴;量完工作目录里不留取来的素材', false, { reason: !hasFfmpeg ? '本机没有 ffmpeg / ffprobe,这一条没有验(留到节点上验)' : '项目里没有提示音(要先跑步骤 sound)' });
    } else {
      const api = agentApi(AGENT_URL, alice);
      const sent = await api.send('snd-measure', mockScript([
        { tool: 'measure_audio', input: { mediaId: chime.id } },
        { tool: 'measure_audio', input: { scope: 'timeline' } },
        { say: '量过了' },
      ]));
      const seen = await api.events('snd-measure', { ms: 120_000 });
      const res = seen.events.filter((e) => e.type === 'tool_result');
      const parse = (e) => { try { return JSON.parse(e?.summary ?? ''); } catch { return null; } };
      const one = parse(res[0]);
      const tl = parse(res[1]);
      const leftovers = [];
      const walk = (d) => { for (const it of fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }) : []) { const q = path.join(d, it.name); if (it.isDirectory()) walk(q); else if (/[\\/]measure[\\/]/.test(q)) leftovers.push(path.relative(D.agent, q)); } };
      walk(path.join(D.agent, 'work'));
      const num = (v) => typeof v === 'number' && Number.isFinite(v);
      check('S3 测响度:量刚生成的提示音与整条时间轴;量完工作目录里不留取来的素材', sent.status === 202 && seen.done && res.length === 2 && res.every((e) => e.ok === true)
        && (one ? num(one.integrated) && num(one.truePeak) && one.truePeak <= 0.5 : /"integrated":-?\d/.test(res[0]?.summary ?? '') && /"truePeak":-?\d/.test(res[0]?.summary ?? ''))
        && /"scope":"timeline"/.test(res[1]?.summary ?? '') && /"sounding":\[/.test(res[1]?.summary ?? '') && leftovers.length === 0, {
        tools: res.map((e) => `${e.name}:${e.ok ? 'ok' : `不成 ${String(e.summary).slice(0, 200)}`}`),
        chime: one ? { integrated: one.integrated, truePeak: one.truePeak, lra: one.lra } : String(res[0]?.summary ?? '').slice(0, 200),
        timeline: tl ? { integrated: tl.integrated, seconds: tl.series?.length ?? null, clips: tl.clips?.length ?? null } : String(res[1]?.summary ?? '').slice(0, 200),
        fetchedFilesLeftInWorkspace: leftovers,
      });
    }
  }

  if (STEPS.includes('cardaudio')) {
    const marker = `PC-PROBE-CARD-AUDIO-RAN-${randomBytes(5).toString('hex')}`;
    const source = fs.readFileSync(path.join(ROOT, 'scripts', 'probes', 'fixtures', 'cloud-sound', 'sound-beep.tsx'), 'utf8').replace(/\r\n/g, '\n')
      .replace('const out = new Float32Array(range.count);', `console.log(${JSON.stringify(marker)});\n    const out = new Float32Array(range.count);`);
    const HZ = 1000; const GAIN = 0.5; const SECONDS = 0.5;
    const before = await renderStatus();
    const r = await run(ula, Y, 'snd-card', [
      { tool: 'create_card', input: { id: 'sound-beep', source } },
      { tool: 'add_clip', input: { cardId: 'sound-beep', start: 0, duration: SECONDS, trackId: 'tr-0', params: { hz: HZ, gain: GAIN } } },
      { say: '卡建好了' },
    ], { creativity: 'high' });
    const clipId = clipsOf((await projectOf(ula, Y)).project).find((c) => c.cardId === 'sound-beep')?.id ?? null;
    const r2 = clipId ? await run(ula, Y, 'snd-card-2', [
      { tool: 'render_card_audio', input: { clipId } },
      { tool: 'render_card_audio', input: { clipId } },
      { tool: 'cancel_card_audio', input: { clipId } },
      { say: '卡片声音生成了' },
    ], { creativity: 'high', ms: 420_000 }) : { tools: [], meta: null, ms: 0 };
    const p = (await projectOf(ula, Y)).project;
    const clip = clipsOf(p).find((c) => c.id === clipId) ?? null;
    const media = (p.media ?? []).find((m) => m.id === clip?.cardAudio?.mediaId) ?? null;
    const wav = media?.hash ? await fetchMedia(ula, media.hash) : null;
    const frames = Math.round(SECONDS * 48000);
    let maxDiff = null;
    let exact = 0;
    if (wav && wav.length === 44 + frames * 4) {
      maxDiff = 0;
      for (let n = 0; n < frames; n += 1) {
        const want = Math.fround(Math.sin(2 * Math.PI * HZ * n / 48000) * GAIN);
        const have = wav.readFloatLE(44 + n * 4);
        if (have === want) exact += 1;
        maxDiff = Math.max(maxDiff, Math.abs(have - want));
      }
    }
    const st = await renderStatus();
    const renders = r2.tools.filter((t) => t.name === 'render_card_audio');
    const agentOut = agent.text();
    const rows = usageRows().filter((u) => u.kind === 'service' && u.service === 'card-audio' && u.projectId === Y);
    check('S5 卡片声音:带 audio() 的用户卡由渲染服务的隔离工作进程求值,WAV 入库并登记在原片段上,逐样本等于这张卡的公式;声音代码没有在 Agent 服务进程里执行;再调一次不重算', r.meta?.state === 'idle' && r2.meta?.state === 'idle'
      && renders.length === 2 && renders.every((t) => t.ok) && /"reused":false/.test(renders[0].summary) && /"reused":true/.test(renders[1].summary)
      && /"cancelled":false/.test(r2.tools.find((t) => t.name === 'cancel_card_audio')?.summary ?? '')
      && !!clip?.cardAudio && clip.cardAudio.cardId === 'sound-beep' && clip.cardAudio.frames === frames && clip.cardAudio.channels === 1 && clip.cardAudio.sampleRate === 48000
      && typeof clip.cardAudio.identity?.sourceVersion === 'string' && clip.cardAudio.identity.params?.hz === HZ
      && !!media && media.kind === 'audio' && !!wav && sha256(wav) === media.hash && wav.readUInt16LE(20) === 3 && wav.readUInt32LE(24) === 48000 && wav.readUInt16LE(22) === 1
      && maxDiff !== null && maxDiff <= 1e-6
      && (st.look?.byWorker?.isolated ?? 0) - (before.look?.byWorker?.isolated ?? 0) >= 1 && (st.look?.byWorker?.resident ?? 0) === (before.look?.byWorker?.resident ?? 0)
      && !agentOut.includes(marker) && rows.length === 1 && rows[0].ok === true && rows[0].units === wav.length, {
      end: [r.meta?.state ?? null, r2.meta?.state ?? null], ms: [r.ms, r2.ms], tools: [...toolsLine(r.tools), ...toolsLine(r2.tools)],
      cardAudio: clip?.cardAudio ? { cardId: clip.cardAudio.cardId, frames: clip.cardAudio.frames, channels: clip.cardAudio.channels, sourceVersion: clip.cardAudio.identity?.sourceVersion ?? null, params: clip.cardAudio.identity?.params ?? null } : null,
      media: media ? { name: media.name, hash: `${media.hash.slice(0, 16)}…`, bytes: media.size, seconds: media.duration } : null,
      wav: wav ? { bytes: wav.length, format: wav.readUInt16LE(20), rate: wav.readUInt32LE(24), channels: wav.readUInt16LE(22), samples: frames, exactlyEqual: exact, maxAbsDiff: maxDiff } : null,
      byWorker: { before: before.look?.byWorker ?? null, after: st.look?.byWorker ?? null },
      markerInAgentServiceOutput: agentOut.includes(marker),
      usageRows: rows.map((u) => ({ service: u.service, units: u.units, ok: u.ok })),
      ...(renders.every((t) => t.ok) ? {} : { lookLog: render.logs.filter((l) => /^look\.|isolation\./.test(String(l.event))).slice(-14).map((l) => JSON.stringify(l).slice(0, 240)) }),
    });
  }

  alice.close();
  rita.close();
  ula.close();
  if (STEPS.includes('browser')) {
    await agent?.stop(); agent = null;
    if (render) { await render.stop(30_000); killTree(render.child.pid); render = null; }
    await hosted?.stop(); hosted = null;
    await browserStep();
  }
}

let code = 0;
try {
  await main();
} catch (err) {
  code = 2;
  process.stdout.write(`${JSON.stringify({ check: '探针自己出错', ok: false, message: String(err?.stack ?? err).slice(0, 1500), renderTail: render ? render.text().slice(-1200) : null, agentTail: agent ? agent.text().slice(-800) : null })}\n`);
} finally {
  try { await agent?.stop(); } catch { /* 已经没了 */ }
  try { if (render) { await render.stop(30_000); killTree(render.child.pid); } } catch { /* 已经没了 */ }
  try { await hosted?.stop(); } catch { /* 已经没了 */ }
  try { desktop?.stop(); } catch { /* 已经没了 */ }
  if (desktop) await sleep(1500);
  const left = [];
  for (const port of [DOC_PORT, ASSET_PORT, AGENT_PORT, ...[0, 1, 2, 3, 4, 5, 6].map((d) => RENDER_PORT + d), ...(desktop ? [DESKTOP_PORT, DESKTOP_PORT + 1, DESKTOP_PORT + 2] : [])]) if (await portBusy(port)) left.push(port);
  if (!KEEP) { for (let i = 0; i < 10; i += 1) { try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { await sleep(500); } } }
  const fails = results.filter((r) => !r.ok).map((r) => r.check);
  if (code === 0 && fails.length) code = 1;
  process.stdout.write(`${JSON.stringify({ ok: code === 0, pass: results.filter((r) => r.ok).length, fails, steps: STEPS, portsStillBusy: left, tmp: KEEP ? tmp : null })}\n`);
  process.exit(code);
}
