/**
 * 云端 Agent 的卡片声音(`server/agent/service/hosted-card-audio.mjs`;契约 `docs/plan/cloud-agent-contract.md` 第 9.4c 节)。
 * 跑:node scripts/test-suite.mjs server/test/cloud-agent-card-audio.test.mjs
 *
 *   CA-CAU-01  整条路(渲染服务是替身):把项目副本与片段交给渲染服务 → 核对回来的 WAV 与记录 → 写进素材服务 → 原子登记
 *              (片段多了 `cardAudio`、素材表多了那份 WAV);Agent 服务这一侧没有卡片的定义也照样做成——卡片代码不在这里执行
 *   CA-CAU-02  渲染页回来的东西只当数据逐项核:格式不是 32 位浮点、长度与记录不符、记录不是这张卡的、身份太大、超过上限——
 *              全部拒掉,不上传、不提交
 *   CA-CAU-03  只读成员在问渲染服务之前就被拒;节点没配口子回明确的原因;渲染服务回「这次没看成」时原因带回、开头换掉
 *   CA-CAU-04  复用:记录还对得上且素材服务里真有那份字节才复用;字节没了就强制重算
 *   CA-CAU-05  取消与过期:在途时取消不上传、不提交;等渲染服务期间片段被改,旧结果不应用;同时最多 4 个
 *   CA-CAU-06  工具表:两个工具归「服务端另有实现」,节点没配看画面的口子时不交给模型;渲染服务的口子只多了 `/api/cards/audio` 这一条,
 *              工作进程里它与看画面那一批一样要口令
 *
 * 不出网;真的渲染服务与隔离工作进程由 `scripts/probes/cloud-agent-sound-probe.mjs` 与隔离探针验。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer as createVite } from 'vite';
import { createCardAudioTools, newCardAudioState, checkCardAudioWav, checkRendition } from '../agent/service/hosted-card-audio.mjs';
import { CLOUD_TOOL_PLAN, CLOUD_OPEN_TOOLS, CLOUD_OPEN_TOOLS_NO_LOOK, CLOUD_RENDER_TOOLS, CLOUD_SLOW_TOOLS } from '../agent/service/cloud-tools.mjs';
import { LOOK_ROUTES, LOOK_WORKER_PREFIXES } from '../hosted-render/look.mjs';
import { isLookPath } from '../hosted-render/vite-gate.mjs';
import { loadSsrHost } from '../agent/ssr-host.mjs';
import { ROOT } from './cloud-agent-kit.mjs';

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');
class ToolError extends Error { constructor(message, extra = {}) { super(message); Object.assign(this, extra); } }

/** 一份 32 位浮点的 WAV(渲染页回来的那种) */
function floatWav({ frames = 4800, channels = 2, format = 3, bits = 32, rate = 48000 } = {}) {
  const buf = Buffer.alloc(44 + frames * channels * 4);
  buf.write('RIFF', 0, 'latin1'); buf.writeUInt32LE(buf.length - 8, 4); buf.write('WAVE', 8, 'latin1'); buf.write('fmt ', 12, 'latin1');
  buf.writeUInt32LE(16, 16); buf.writeUInt16LE(format, 20); buf.writeUInt16LE(channels, 22); buf.writeUInt32LE(rate, 24); buf.writeUInt32LE(rate * channels * 4, 28);
  buf.writeUInt16LE(channels * 4, 32); buf.writeUInt16LE(bits, 34); buf.write('data', 36, 'latin1'); buf.writeUInt32LE(frames * channels * 4, 40);
  for (let i = 0; i < frames * channels; i += 1) buf.writeFloatLE(Math.sin(i / 20) * 0.3, 44 + i * 4);
  return buf;
}
const renditionOf = (clip, { frames = 4800, channels = 2 } = {}) => ({
  version: 1, cardId: clip.cardId, sourceKey: 'a'.repeat(64), sourceOffset: 0, duration: frames / 48000, sampleRate: 48000, frames, channels,
  identity: { cardId: clip.cardId, sourceVersion: 'v1', defaults: {}, params: clip.params ?? {}, inputs: {} },
});
const clipOf = (p, id) => p.tracks.flatMap((t) => t.clips).find((c) => c.id === id);

async function setup(t) {
  const vite = await createVite({ configFile: false, root: ROOT, logLevel: 'silent', server: { middlewareMode: true, hmr: false, ws: false, watch: null }, appType: 'custom', optimizeDeps: { noDiscovery: true, include: [] } });
  t.after(() => vite.close());
  const host = await loadSsrHost((id) => vite.ssrLoadModule(id));
  function instance({ readOnly = false, noLook = false } = {}) {
    const st = {
      // 这张卡(`user-beep`)在 Agent 服务这一侧没有定义:它的 audio() 只在渲染服务那边
      project: {
        version: 1, id: 'p-cau', name: '卡片声音', width: 1920, height: 1080, fps: 30, duration: 10, themeId: 'midnight', media: [],
        tracks: [{ id: 't1', name: '序列 1', clips: [
          { id: 'k1', cardId: 'user-beep', start: 1, end: 1.1, params: { hz: 440 }, label: '哔', embeddedAudio: true },
          { id: 'k2', cardId: 'user-beep', start: 3, end: 3.1, params: { hz: 880 }, label: '哔二', embeddedAudio: true },
        ] }], transitions: [],
      },
      asks: [], puts: [], commits: 0, usage: [], stored: new Set(), reply: null, beforeCommit: null, state: newCardAudioState(),
    };
    st.reply = (body) => ({ ok: true, clipId: body.clipId, expectedClip: 'ignored', name: '哔 · 卡片声音.wav', bytes: floatWav().length, rendition: renditionOf(clipOf(st.project, body.clipId)), wav: floatWav().toString('base64') });
    st.tools = createCardAudioTools({
      state: st.state, ToolError,
      look: () => (noLook ? null : async (path, body, opts) => { st.asks.push({ path, body, opts }); return st.reply(body, opts); }),
      snapshot: async () => ({ project: st.project }),
      mutate: async (_track, apply) => {
        st.beforeCommit?.();
        host.resetStore(); host.setProject(st.project);
        try { await apply(host); st.project = host.getProject(); st.commits += 1; } finally { host.clearProject(); }
      },
      ensureCanWrite: async () => { if (readOnly) throw new ToolError('你在这个项目里只有只读权限,云端 Agent 不能替你把素材写进项目。'); },
      put: async (wav) => { const copy = Buffer.from(wav); st.puts.push(copy); st.stored.add(sha256(copy)); return { hash: sha256(copy), size: copy.length }; },
      has: async (hash) => st.stored.has(hash),
      record: (row) => st.usage.push(row),
    });
    return st;
  }
  return { host, instance };
}

test('CA-CAU-01 整条路:交给渲染服务 → 核对 → 入库 → 原子登记;卡片代码不在这一侧执行', { timeout: 120_000 }, async (t) => {
  const { host, instance } = await setup(t);
  const a = instance();
  assert.equal(host.cardIds().includes('user-beep'), false, 'Agent 服务这一侧没有这张卡的定义');
  assert.deepEqual(Object.keys(host.cardAudio), ['commit'], '前端代码的缝里卡片声音只有「登记」这一个口,没有求值');
  const out = await a.tools.render_card_audio({ clipId: 'k1' }, {});
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual([out.clipId, out.reused], ['k1', false]);
  assert.equal(a.asks.length, 1);
  assert.equal(a.asks[0].path, '/api/cards/audio');
  assert.deepEqual([a.asks[0].body.clipId, a.asks[0].body.force, a.asks[0].body.project.id], ['k1', false, 'p-cau']);
  assert.ok(a.asks[0].opts.signal instanceof AbortSignal);
  const clip = clipOf(a.project, 'k1');
  const media = a.project.media.find((m) => m.id === out.mediaId);
  assert.ok(media);
  assert.deepEqual([media.kind, media.ext, media.name, media.duration], ['audio', 'wav', '哔 · 卡片声音.wav', 0.1]);
  assert.equal(media.hash, sha256(a.puts[0]));
  assert.equal(media.url, `/@media/${media.hash}`);
  assert.ok(a.puts[0].equals(floatWav()), '入库的就是渲染服务回来的那份字节');
  assert.deepEqual({ ...clip.cardAudio, identity: undefined }, { ...renditionOf(clip), identity: undefined, mediaId: media.id });
  assert.deepEqual(clip.cardAudio.identity, renditionOf(clip).identity);
  assert.equal(clipOf(a.project, 'k2').cardAudio, undefined, '别的片段没动');
  assert.deepEqual(a.usage.map((u) => [u.service, u.vendor, u.unit, u.units, u.ok]), [['card-audio', 'render', 'bytes', floatWav().length, true]]);
  assert.deepEqual(await a.tools.cancel_card_audio({ clipId: 'k1' }), { ok: true, cancelled: false });
});

test('CA-CAU-02 渲染页回来的东西逐项核,不对的不上传、不提交', { timeout: 120_000 }, async (t) => {
  const { instance } = await setup(t);
  const bad = {
    '格式不是浮点': (st, b) => ({ ...st.good(b), wav: floatWav({ format: 1 }).toString('base64') }),
    '位深不对': (st, b) => ({ ...st.good(b), wav: floatWav({ bits: 16 }).toString('base64') }),
    '采样率不对': (st, b) => ({ ...st.good(b), wav: floatWav({ rate: 44100 }).toString('base64') }),
    '长度与记录不符': (st, b) => ({ ...st.good(b), wav: floatWav({ frames: 4801 }).toString('base64') }),
    '声道与记录不符': (st, b) => ({ ...st.good(b), wav: floatWav({ channels: 1, frames: 9600 }).toString('base64') }),
    '不是 WAV': (st, b) => ({ ...st.good(b), wav: Buffer.alloc(4844, 7).toString('base64') }),
    '记录不是这张卡的': (st, b) => ({ ...st.good(b), rendition: { ...st.good(b).rendition, cardId: 'title' } }),
    '记录版本不对': (st, b) => ({ ...st.good(b), rendition: { ...st.good(b).rendition, version: 2 } }),
    '记录的长度离谱': (st, b) => ({ ...st.good(b), rendition: { ...st.good(b).rendition, frames: 61 * 48000 } }),
    '记录的键不对': (st, b) => ({ ...st.good(b), rendition: { ...st.good(b).rendition, sourceKey: '../x' } }),
    '身份太大': (st, b) => ({ ...st.good(b), rendition: { ...st.good(b).rendition, identity: { blob: 'x'.repeat(100 * 1024) } } }),
    '没有记录': (st, b) => ({ ...st.good(b), rendition: null }),
    '没有声音': (st, b) => ({ ...st.good(b), wav: undefined }),
    '工作进程说没成': () => ({ ok: false, code: 'CARD_AUDIO_FAILED', error: '这张卡没有内嵌声音' }),
    '回的不是对象': () => 'nope',
  };
  for (const [name, make] of Object.entries(bad)) {
    const st = instance();
    st.good = st.reply;
    st.reply = (b) => make(st, b);
    const out = await st.tools.render_card_audio({ clipId: 'k1' }, {});
    assert.deepEqual([out.ok, out.code], [false, 'CARD_AUDIO_FAILED'], `${name}: ${JSON.stringify(out)}`);
    assert.equal(st.puts.length, 0, `${name}:没有上传`);
    assert.equal(st.commits, 0, `${name}:没有提交`);
    assert.equal(st.project.media.length, 0);
  }
  // 超过上限(按 base64 的长度先拒,不解码)
  const big = instance();
  big.tools = createCardAudioTools({ state: newCardAudioState(), look: () => async (_p, b) => big.reply(b), snapshot: async () => ({ project: big.project }), mutate: async () => { throw new Error('不该提交'); }, ensureCanWrite: async () => {}, put: async () => { throw new Error('不该上传'); }, has: async () => false, limits: { maxWavBytes: 1000 } });
  assert.match((await big.tools.render_card_audio({ clipId: 'k1' }, {})).error, /太大/);
  // 两个纯函数
  const clip = { cardId: 'user-beep' };
  assert.equal(checkCardAudioWav(floatWav(), renditionOf(clip)), null);
  assert.match(checkCardAudioWav(floatWav().subarray(0, 40), renditionOf(clip)), /太短/);
  assert.deepEqual(Object.keys(checkRendition({ ...renditionOf(clip), extra: '多出来的字段不留', mediaId: 'x' }, clip)).sort(), ['cardId', 'channels', 'duration', 'frames', 'identity', 'sampleRate', 'sourceKey', 'sourceOffset', 'version']);
});

test('CA-CAU-03 / 04 / 05 只读、没配口子、没看成的原因;复用;取消、过期与上限', { timeout: 120_000 }, async (t) => {
  const { instance } = await setup(t);

  const ro = instance({ readOnly: true });
  await assert.rejects(ro.tools.render_card_audio({ clipId: 'k1' }, {}), /只读/);
  assert.equal(ro.asks.length, 0, '只读成员:没有去问渲染服务');
  await assert.rejects(ro.tools.render_card_audio({}, {}), /clipId/);

  const none = instance({ noLook: true });
  const off = await none.tools.render_card_audio({ clipId: 'k1' }, {});
  assert.deepEqual([off.ok, off.cloudUnavailable], [false, true]);
  assert.match(off.error, /只在渲染服务的隔离进程里执行/);

  const busy = instance();
  busy.reply = () => { throw new Error('这次没看成：渲染服务正在渲别的项目的自定义卡片，带自定义卡片的项目要排队。过一会儿再看，先按项目内容继续。'); };
  const b = await busy.tools.render_card_audio({ clipId: 'k1' }, {});
  assert.deepEqual([b.ok, b.code], [false, 'CARD_AUDIO_FAILED']);
  assert.match(b.error, /^卡片声音这次没有生成:渲染服务正在渲别的项目/);
  assert.equal((await busy.tools.render_card_audio({ clipId: 'nope' }, {})).ok, false);

  // 复用
  const a = instance();
  const first = await a.tools.render_card_audio({ clipId: 'k1' }, {});
  const good = a.reply;
  a.reply = (body) => (body.force ? good(body) : { ok: true, clipId: body.clipId, expectedClip: 'x', reusable: { mediaId: 'page-says', hash: 'f'.repeat(64) } });
  const again = await a.tools.render_card_audio({ clipId: 'k1' }, {});
  assert.deepEqual(again, { ok: true, clipId: 'k1', mediaId: first.mediaId, reused: true }, '复用时认的是项目素材表里那一条,不认渲染页报的素材');
  assert.equal(a.puts.length, 1);
  a.stored.clear(); // 素材服务里那份字节没了
  const redo = await a.tools.render_card_audio({ clipId: 'k1' }, {});
  assert.deepEqual([redo.ok, redo.reused], [true, false]);
  assert.deepEqual(a.asks.slice(-2).map((x) => x.body.force), [false, true], '字节没了就强制重算');
  assert.equal(a.puts.length, 2);

  // 取消:在途时取消
  const c = instance();
  let release;
  const gate = new Promise((r) => { release = r; });
  const goodC = c.reply;
  c.reply = async (body, opts) => { await Promise.race([gate, new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(new Error('aborted'))))]); return goodC(body); };
  const pending = c.tools.render_card_audio({ clipId: 'k1' }, {});
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(await c.tools.cancel_card_audio({ clipId: 'k1' }), { ok: true, cancelled: true });
  const cancelled = await pending;
  assert.deepEqual([cancelled.ok, cancelled.code], [false, 'CARD_AUDIO_CANCELLED']);
  assert.deepEqual([c.puts.length, c.commits, c.project.media.length], [0, 0, 0]);
  release();

  // 过期:等渲染服务期间片段被改
  const s = instance();
  s.beforeCommit = () => { s.project = { ...s.project, tracks: s.project.tracks.map((tr) => ({ ...tr, clips: tr.clips.map((x) => (x.id === 'k1' ? { ...x, params: { hz: 123 } } : x)) })) }; };
  const stale = await s.tools.render_card_audio({ clipId: 'k1' }, {});
  assert.deepEqual([stale.ok, stale.code], [false, 'CARD_AUDIO_FAILED']);
  assert.match(stale.error, /已变化/);
  assert.equal(clipOf(s.project, 'k1').cardAudio, undefined);

  // 上限:同时最多 4 个
  const q = instance();
  q.project = { ...q.project, tracks: [{ ...q.project.tracks[0], clips: [0, 1, 2, 3, 4].map((i) => ({ id: `q${i}`, cardId: 'user-beep', start: i, end: i + 0.1, params: {}, label: `q${i}`, embeddedAudio: true })) }] };
  let open;
  const hold = new Promise((r) => { open = r; });
  const goodQ = q.reply;
  q.reply = async (body) => { await hold; return goodQ(body); };
  const four = [0, 1, 2, 3].map((i) => q.tools.render_card_audio({ clipId: `q${i}` }, {}));
  await new Promise((r) => setTimeout(r, 30));
  const fifth = await q.tools.render_card_audio({ clipId: 'q4' }, {});
  assert.match(fifth.error, /最多同时排队 4 个/);
  open();
  assert.deepEqual((await Promise.all(four)).map((r) => r.ok), [true, true, true, true]);
});

test('CA-CAU-06 工具表与渲染服务的口子', () => {
  for (const n of ['render_card_audio', 'cancel_card_audio']) {
    assert.deepEqual(CLOUD_TOOL_PLAN[n], { mode: 'hosted', render: true });
    assert.ok(CLOUD_OPEN_TOOLS.has(n));
    assert.equal(CLOUD_OPEN_TOOLS_NO_LOOK.has(n), false, '节点没配口子时不交给模型');
  }
  assert.deepEqual([...CLOUD_RENDER_TOOLS].sort(), ['cancel_card_audio', 'render_card_audio']);
  assert.ok(CLOUD_SLOW_TOOLS.has('render_card_audio'));
  assert.deepEqual(LOOK_ROUTES['/api/cards/audio'], { tool: 'render_card_audio' });
  assert.equal(Object.keys(LOOK_ROUTES).length, 7, '口子上只多了卡片声音这一条');
  assert.ok(LOOK_WORKER_PREFIXES.includes('/api/cards/audio'));
  assert.equal(isLookPath('/api/cards/audio'), true, '工作进程里这条接口与看画面那一批一样要口令');
  assert.equal(isLookPath('/api/cards/audio?x=1'), true);
  assert.equal(isLookPath('/api/cards/install'), false);
});
