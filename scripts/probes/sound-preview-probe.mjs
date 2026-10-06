/**
 * 声音预览的浏览器端验收(任务书「第一段」第 3 条;浏览器里的真实行为,用探针断言,不靠人听)。
 *
 *   node scripts/probes/sound-preview-probe.mjs [--mode desktop|online|both] [--out <目录>] [--base-port 5780]
 *        [--doc-port 8786] [--asset-port 8787] [--dist <在线构建目录>] [--keep-temp]
 *
 * 同一套断言(runSuite)跑四遍,覆盖声音的每一种播放来源:
 *   - desktop:桌面版形态。本机编辑器 dev server(本脚本所在代码树,临时数据目录),页面 `/?editor&nosetup=1`;
 *   - reopened:同一个项目「打包保存」后在空数据目录的另一台编辑器里打开(只跑 P1);
 *   - online:在线浏览器模式,声音来源是**已经生成入库的产物**。本机隔离的托管组合(文档服务 + 素材服务,只绑 127.0.0.1)
 *     + 仿 nginx 的代理 + 在线构建;创建者 = 桌面形态那一页(在项目设置里勾「多用户协作」放云端),成员 = 在线页面凭邀请链接加入;
 *   - online-live:在线浏览器模式,声音来源是**浏览器合成的临时声音**。代理把三份声音的字节挡成「素材服务里没有」
 *     (项目里的记录都在),另开一个成员页加入:键盘声、提示音按配方在浏览器里合成,声画卡由浏览器执行它的 audio() 合成。
 *   每一遍都断言三段声音的播放源确实是这一遍要验的那种(元素上的 `data-pc-audio-source`:product / live)。
 *   绝不连生产节点、不碰阿里云。
 * 端口:--base-port 起 +0～+2 桌面 dev server(含两个舞台端口)、+3 在线页面的源、+4 / +5 两个舞台的源、
 *       +6～+8 第二台(空数据目录的)桌面 dev server;--doc-port / --asset-port 托管组合。
 *
 * 场景(三种声音各一):
 *   - 打字机画面卡 mu-typing(0～7 秒,43 个字每字 90 ms)+ 经「生成键盘声」按钮生成的独立键盘声音片段(普通音频片段,长);
 *   - 「结尾加提示音」生成的提示音片段(短,时间轴上很窄);
 *   - 声画卡 av-pulse(5.2～6.2 秒)经「生成声音」按钮生成、依附同一片段的内嵌声音。
 *
 * 不靠人听的做法:无头 Chrome 带 --mute-audio(测试期间扬声器无输出)。每 12 ms 采样一次
 * { 时间轴 t, 每个声音元素的片段 id、来源、currentTime、暂停、readyState、seeking、ended、loadstart 次数、实时能量 }。
 *   - 元素按 `data-pc-audio-clip`(片段 id)归类,不看地址 —— 合成的临时声音是 blob 地址,没有哈希。
 *   - 实时能量:元素 captureStream → AnalyserNode(只量不出声)。元素重新加载后原来那条采集音轨不再出数据、状态却仍是 live,
 *     所以握着采集流,每次 addtrack 重接。
 *   - 另解码元素实际播的那份字节,核对每个事件位置上有能量(不依赖实时采样的时序;两种来源同一条断言)。
 *   - 「在出声」的拍 = 时间轴在播、元素没暂停、readyState ≥ 3、不在 seek。还没加载好的元素 currentTime 读出来是 0,
 *     它并没有出声,不算进对齐。
 *   - 不按墙钟睡:等播放头走到指定位置(机器慢时时间轴走得慢,睡固定时长会量不到后面的片段)。
 *
 * 验收标准(退出码 0 当且仅当全部通过):
 *   P1 从头播放(这一页第一次播放):三段声音的来源对;起播时声音不抢在播放头前面;元素位置与时间轴对齐(见「阈值」);
 *      键盘声已采到的事件窗口(媒体时间 [E-0.02, E+0.12])里能量 ≥ 阈值的占 ≥ 80%;提示音、声画卡有能量;
 *      出声之后元素没有在播放中重新加载;放到素材尽头的元素没有从头重播;播的那份字节解码后事件位置上有能量;
 *   P2 暂停:暂停后 ≤ 300 ms 所有声音元素都停下、能量落到阈值以下;
 *   P3 拖动(真实指针拖卡尺):拖动途中没有元素在播放;松手后播放头停在指针处,元素停在对应的素材位置;
 *   P4 从片段中间开始播放:凡是没暂停、有数据的拍,currentTime 都不早于中间位置(不回到 0),之后一路对齐;被听到的事件都在中间位置之后;
 *   P5 片段静音与恢复(真实右键菜单):静音后片段有 data-audio-muted、时间轴有「已静音」标记(宽片段整块标记,窄片段外置图标),
 *      播放扫过它时没有该片段的声音元素、其他片段照常;恢复后标记消失、声音回来并接着当前位置;
 *   P6 声画卡:内嵌声音与画面是同一个片段(时间轴上没有第二个片段),元素的 data-card-audio-state = ready,从中间开始不重来。
 *
 * 阈值(2026-10-06 改,原因):
 *   - ALIGN_SEC = 0.15 s、占比 ≥ 90%:没改。用于起播前就挂着的元素(P1 键盘声、P4、P6 中间、P5 恢复)。
 *     只是分母换成「在出声」的拍:原来把还没加载好的元素(currentTime 恒为 0)也算进去,加载慢 0.2 秒就整条不过。
 *   - 播放中才挂上的元素(P1 的提示音、声画卡,第 7 条 Agent 生成的声音):它的元素在播放头进片段那一刻才建,
 *     起声比播放头晚「加载这份声音要的时间」,之后由驱动用 ±10% 变速慢慢追(`src/render/mediaSync.ts`,偏差 0.5 s 以内不 seek)。
 *     这一截是加载时间,不是位置错:原来拿它和 0.15 s 比,空闲机器上中位数 0.10～0.13 s,压着线,机器一忙就过线。
 *     改成两条一起判:偏差的中位数在 [−LATE_START_SEC(0.25 s), +0.05 s](晚得有限、且不超前),
 *     并且 ≥ 90% 的拍离中位数不超过 STEADY_SEC(0.08 s)(起声之后 1:1 往前走,没有跳、没有重来)。0.25 s 是硬 seek 门槛的一半。
 *   - MIN_TIMELINE_RATE = 0.9:这一遍播放里时间轴相对墙钟的速率低于它,测量条件不成立(播放头由舞台逐拍推进,
 *     机器被别的任务占满时走不到实时;驱动的变速只有 ±10%),这一遍不作数。
 *   - 带时间的断言没过或测量条件不成立时,该段整段重量,最多 3 遍;每次重量打一行 RETRY 并记进结果的 retries。
 *     不带时间的断言(来源、不从头重来、不重新加载、标记、暂停即停)不因此重量。
 * 截图写进 --out:<形态>-1-playing.png、<形态>-2-muted-playing.png 等;每段采样写成 trace-<形态>-<序号>.json(排查用)。
 */
import '../lib/no-user-dirs.mjs';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import dnsShim from './lib/localhost-dns.cjs'; // Node 这边也认得 *.localhost(托管组合对外说的是 pc.localhost)
import { startHostedProxy, proxyOrigins } from './lib/hosted-proxy.mjs';
import { startDevServer, viteBin } from '../lib/dev-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const argv = process.argv.slice(2);
const arg = (name, fallback) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : fallback);
const MODE = arg('mode', 'both');
const BASE = Number(arg('base-port', 5780));
// 探针起的 Node 子进程(桌面 dev server)继承它,也能解析 pc.localhost(桌面创建者页填的托管端地址是 pc.localhost)
process.env.NODE_OPTIONS = dnsShim.withLocalhostDns(process.env.NODE_OPTIONS);
const DOC_PORT = Number(arg('doc-port', 8786));
const ASSET_PORT = Number(arg('asset-port', 8787));
const OUT = path.resolve(arg('out', path.join(ROOT, '..', '..', 'work', 'four-stage', 'sound', 'preview')));
const KEEP = argv.includes('--keep-temp');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-sound-preview-'));
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const fails = [];
const check = (ok, name, evidence = {}) => {
  results.push({ ok: !!ok, name, evidence });
  if (!ok) fails.push(name);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name} ${JSON.stringify(evidence).slice(0, 700)}`);
  return !!ok;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 30_000, every = 200) {
  const t0 = Date.now();
  let last = null;
  for (;;) {
    let v = null;
    try { v = await Promise.race([fn(), new Promise((_, rej) => setTimeout(() => rej(new Error('单次检查超过 30 s 没返回')), 30_000))]); } catch (e) { last = String(e?.message ?? e); }
    if (v) return v;
    if (Date.now() - t0 > ms) { fails.push(`等不到:${what}${last ? ` (${last.slice(0, 160)})` : ''}`); console.log(`FAIL 等不到:${what} ${last ?? ''}`); return null; }
    await sleep(every);
  }
}
const P = (page, fn, ...a) => page.evaluate(fn, ...a);

/* ================================================================== 页面里的采样器 */
const HARNESS = () => {
  const state = { trace: [], timer: null, hooks: new WeakMap(), ctx: null, ids: new WeakMap(), seq: 0, bytes: new Map() };
  const store = () => window.__pcStore;
  /** 把元素此刻的那条采集音轨接到一个分析节点上(只量不出声:不接 destination) */
  const attach = (h) => {
    // 取最新的一条:元素重新加载后旧音轨还留在流里、状态也还是 live,只是不再出数据
    const track = h.stream.getAudioTracks().filter((x) => x.readyState === 'live').at(-1);
    if (!track || track === h.track) return;
    try { h.src?.disconnect(); } catch { /* 已断 */ }
    h.track = track;
    h.src = state.ctx.createMediaStreamSource(new MediaStream([track]));
    h.an = state.ctx.createAnalyser();
    h.an.fftSize = 1024;
    h.src.connect(h.an);
  };
  /*
   * 元素重新加载(换地址、原地址重设、load())之后,原来那条采集音轨不再出数据,readyState 却仍是 live
   * (Chrome 152 实测);新的音轨经 addtrack 加到同一个采集流上。所以握着流、每次 addtrack 重接,
   * 并数下元素的 loadstart 次数(播放中重新加载 = 声音断一下,另有断言)。
   */
  const hook = (el) => {
    let h = state.hooks.get(el);
    if (!h) {
      h = { stream: null, track: null, src: null, an: null, buf: new Float32Array(1024), loads: 0, alive: false, zeros: 0, recaps: 0 };
      el.addEventListener('loadstart', () => { h.loads++; h.alive = false; h.zeros = 0; });
      state.hooks.set(el, h);
    }
    if (!h.stream && el.readyState >= 1 && el.captureStream) {
      try {
        state.ctx ??= new AudioContext();
        h.stream = el.captureStream();
        h.stream.addEventListener('addtrack', () => attach(h));
      } catch { /* 下一拍再试 */ }
    }
    if (h.stream) { try { attach(h); } catch { /* 下一拍再试 */ } }
    return h;
  };
  const tick = () => {
    const s = store()?.getState();
    if (!s) return;
    const els = [];
    for (const el of document.querySelectorAll('audio')) {
      const h = hook(el);
      let rms = null;
      if (h.an) {
        h.an.getFloatTimeDomainData(h.buf);
        let e = 0;
        for (const v of h.buf) e += v * v;
        rms = Math.sqrt(e / h.buf.length);
      }
      /*
       * 采集音轨偶尔从接上起就不出数据(状态仍是 live;Chrome 152 上拖动中、播放中才挂上的元素见过,单独复现不出来)。
       * 元素明明在出声、读数却连续恰好是 0,而且这条采集从没读到过能量:重新 captureStream 一条再接,每个元素最多 3 次。
       * 这只是让「实时采样」这一路尽量可用;「听到了没有」的判定不靠它(见 heardEvents)。
       */
      if (h.an && s.playing && !el.paused && el.readyState >= 3 && !el.seeking && el.volume > 0 && !el.muted) {
        if (rms > 1e-7) { h.alive = true; h.zeros = 0; }
        else if (!h.alive && ++h.zeros >= 8 && h.recaps < 3) {
          h.zeros = 0; h.recaps++;
          try { h.stream = el.captureStream(); h.stream.addEventListener('addtrack', () => attach(h)); h.track = null; attach(h); } catch { /* 下一拍再试 */ }
        }
      }
      if (!state.ids.has(el)) state.ids.set(el, ++state.seq);
      const src = el.currentSrc || el.src || '';
      const clip = el.getAttribute('data-pc-audio-clip');
      // 记下这一段此刻播的那份字节(每个地址只取一次),播完后解码核对「播的这份声音里事件在不在」
      if (clip && src && el.readyState >= 3 && !state.bytes.has(`${clip}|${src}`)) {
        state.bytes.set(`${clip}|${src}`, fetch(src).then((r) => (r.ok ? r.arrayBuffer() : null)).catch(() => null));
      }
      els.push({ el: state.ids.get(el), clip, source: el.getAttribute('data-pc-audio-source'), src, node: el.getAttribute('data-card-audio-node'), cstate: el.getAttribute('data-card-audio-state'),
        ct: el.currentTime, paused: el.paused, vol: el.volume, muted: el.muted, recaps: h.recaps, rms, hooked: !!h.an, ready: el.readyState, seeking: el.seeking, ended: el.ended, loads: h.loads, err: el.error?.code ?? null, rate: el.playbackRate });
    }
    state.trace.push({ w: performance.now(), t: s.t, playing: s.playing, els });
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__sv = {
    async start() {
      state.trace = [];
      state.ctx ??= new AudioContext();
      await state.ctx.resume().catch(() => {});
      clearInterval(state.timer);
      state.timer = setInterval(tick, 12);
      tick();
    },
    stop() { clearInterval(state.timer); state.timer = null; const t = state.trace; state.trace = []; return t; },
    snapshot: () => state.trace.length,
    ctxState: () => state.ctx?.state ?? null,
    /** 等播放头走到 to(或播到头自己停下);不按墙钟睡:机器慢时时间轴走得慢,睡固定时长会量不到后面的片段 */
    async waitT(to, maxMs) {
      const t0 = performance.now();
      let started = false;
      while (performance.now() - t0 < maxMs) {
        const st = store().getState();
        if (st.playing) started = true;
        if (st.t >= to - 1e-6) break;
        if (started && !st.playing) break;
        await sleep(15);
      }
      const st = store().getState();
      return { t: st.t, playing: st.playing, wallMs: performance.now() - t0 };
    },
    async playTo(from, to, maxMs) {
      const s = store();
      s.actions.pause(); s.actions.seek(from); s.actions.play();
      return window.__sv.waitT(to, maxMs);
    },
    /**
     * 旁路核对(只在实时采样整段读到 0 时用):把这一段的元素接进 Web Audio(createMediaElementSource),直接量元素的输出。
     * 用来分清「元素真的没出声」和「captureStream 那条采集音轨不出数据」。接上之后元素的声音只走节点图,所以只对马上要卸掉的元素用。
     */
    async elementOutput(clipId, ms) {
      const el = [...document.querySelectorAll('audio')].find((e) => e.getAttribute('data-pc-audio-clip') === clipId);
      if (!el) return { error: '没有这个片段的声音元素' };
      try {
        const src = state.ctx.createMediaElementSource(el);
        const an = state.ctx.createAnalyser();
        an.fftSize = 1024;
        src.connect(an); src.connect(state.ctx.destination);
        const b = new Float32Array(1024);
        let peak = 0, playingSamples = 0;
        const t0 = performance.now();
        while (performance.now() - t0 < ms) {
          an.getFloatTimeDomainData(b);
          let e = 0;
          for (const v of b) e += v * v;
          if (!el.paused) { playingSamples++; peak = Math.max(peak, Math.sqrt(e / b.length)); }
          await sleep(12);
        }
        return { peak, playingSamples, ct: el.currentTime, vol: el.volume };
      } catch (e) { return { error: String(e?.message ?? e).slice(0, 120) }; }
    },
    /** 解码采样时记下的那几份字节,回每个事件窗口 [E, E+0.06] 的 RMS(按片段 id) */
    async sourceEnergy(wanted) {
      const out = {};
      for (const [key, pending] of state.bytes) {
        const [clip, src] = [key.slice(0, key.indexOf('|')), key.slice(key.indexOf('|') + 1)];
        const events = wanted[clip];
        if (!events) continue;
        const bytes = await pending;
        if (!bytes) { (out[clip] ??= []).push({ src: src.slice(0, 5), error: '取不到字节' }); continue; }
        try {
          const buf = await state.ctx.decodeAudioData(bytes.slice(0));
          const ch = buf.getChannelData(0), sr = buf.sampleRate;
          const rmsAt = (E) => { const a = Math.max(0, Math.floor(E * sr)), b = Math.min(ch.length, a + Math.floor(0.06 * sr)); let e = 0; for (let i = a; i < b; i++) e += ch[i] * ch[i]; return b > a ? Math.sqrt(e / (b - a)) : 0; };
          (out[clip] ??= []).push({ kind: src.startsWith('blob:') ? 'blob' : 'url', duration: buf.duration, rms: events.map(rmsAt) });
        } catch (e) { (out[clip] ??= []).push({ error: String(e?.message ?? e).slice(0, 80) }); }
      }
      return out;
    },
  };
};

/* ================================================================== 场景(在页面里用真实按钮、真实生成流程搭) */
const TEXT = 'The quick brown fox jumps over the lazy dog';
/** 左栏切到「编辑」(参数面板、生成声音按钮都在这一页) */
const openEdit = (page) => P(page, () => { const b = document.querySelector('[data-pc-rail="edit"]'); if (b && b.getAttribute('aria-pressed') !== 'true') b.click(); });
async function buildScenario(page) {
  await P(page, async (text) => {
    const S = window.__pcStore;
    const { createEmptyProject } = await import('/src/kernel/project.ts');
    S.actions.loadProject({ ...createEmptyProject('声音预览验收'), width: 1280, height: 720, fps: 30, duration: 8, media: [],
      tracks: [{ id: 't-vis', name: '画面', clips: [] }, { id: 't-av', name: '声画', clips: [] }] });
    const c = S.actions.addCardClip('mu-typing', 0, { trackId: 't-vis', duration: 7, params: { text, duration: 90 } });
    S.actions.select([c.id]);
    window.__svTyping = c.id;
  }, TEXT);
  await openEdit(page);
  const clickData = async (sel, label) => {
    const el = await page.waitForSelector(sel, { visible: true, timeout: 20_000 }).catch(() => null);
    if (!el) throw new Error(`找不到按钮 ${label}`);
    await el.click();
  };
  const mediaCount = () => P(page, () => window.__pcStore.getState().project.media.length);
  // 点按钮 → 等素材入库;失败时把页面上的任务状态与提示原样记下来(排查用),最多再点两次
  const generate = async (sel, label, want) => {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await P(page, () => window.__pcStore.actions.select([window.__svTyping]));
      await openEdit(page);
      await clickData(sel, label);
      const t0 = Date.now();
      while (Date.now() - t0 < 25_000) { if ((await mediaCount()) >= want) return; await sleep(250); }
      const diag = await P(page, () => ({ jobs: [...document.querySelectorAll('[data-pc="sound-job"]')].map((j) => `${j.getAttribute('data-state')}:${j.textContent.slice(0, 80)}`), alerts: [...document.querySelectorAll('[role="alert"]')].map((a) => a.textContent.slice(0, 120)), media: window.__pcStore.getState().project.media.length }));
      console.log(`[scenario] ${label} 第 ${attempt} 次 25 s 内没入库:${JSON.stringify(diag)}`);
    }
    throw new Error(`${label}没生成`);
  };
  await generate('[data-pc="sound-keyboard"]', '生成键盘声', 1);
  await generate('[data-pc="sound-typing-end"]', '结尾加提示音', 2);
  const av = await P(page, () => {
    const S = window.__pcStore;
    const c = S.actions.addCardClip('av-pulse', 5.2, { trackId: 't-av', duration: 1 });
    S.actions.select([c.id]);
    return c.id;
  });
  await openEdit(page);
  await page.waitForSelector('[data-pc="card-audio-controls"]', { visible: true, timeout: 20_000 });
  await P(page, () => { for (const b of document.querySelectorAll('[data-pc="card-audio-controls"] button')) if (b.textContent.trim() === '生成声音') b.click(); });
  if (!(await until('声画卡声音入库并提交', () => P(page, (id) => !!window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id)?.cardAudio, av), 60_000))) throw new Error('声画卡声音没生成');
  // 取场景的真值:每个声音的片段、素材哈希、事件的媒体时间
  return P(page, async (avId) => {
    const S = window.__pcStore;
    const p = S.getState().project;
    const SR = 48000;
    const clips = p.tracks.flatMap((t) => t.clips.map((c) => ({ ...c, trackId: t.id })));
    const out = {};
    for (const c of clips) {
      const m = c.mediaId ? p.media.find((x) => x.id === c.mediaId) : null;
      if (m?.soundEffect?.recipe?.preset === 'keyboard') out.kbd = { id: c.id, start: c.start, end: c.end, off: c.mediaOffset ?? 0, hash: m.hash, events: m.soundEffect.recipe.events.map((e) => e.frame / SR) };
      else if (m?.soundEffect?.recipe?.preset === 'notification') out.notif = { id: c.id, start: c.start, end: c.end, off: c.mediaOffset ?? 0, hash: m.hash, events: m.soundEffect.recipe.events.map((e) => e.frame / SR) };
      if (c.id === avId) {
        const cm = p.media.find((x) => x.id === c.cardAudio.mediaId);
        out.av = { id: c.id, start: c.start, end: c.end, off: 0, hash: cm.hash, events: [0], cardAudio: c.cardAudio };
      }
    }
    out.clipCount = clips.length;
    out.avDuplicateAudioClips = clips.filter((c) => c.mediaId && p.media.find((x) => x.id === c.mediaId)?.hash === out.av.hash).length;
    out.tracks = p.tracks.map((t) => ({ id: t.id, n: t.clips.length }));
    out.typing = window.__svTyping;
    return out;
  }, av);
}

/* ================================================================== 采样分析 */
const THR = 0.003;
/** 元素与时间轴的偏差在这以内算对齐(秒);与改动前相同 */
const ALIGN_SEC = 0.15;
/** 播放中才挂上的元素:起声最多晚这么久(秒)。见文件头「阈值」 */
const LATE_START_SEC = 0.25;
/** 播放中才挂上的元素:起声之后偏差围绕中位数的抖动上限(秒) */
const STEADY_SEC = 0.08;
/** 时间轴相对墙钟的速率低于这个值,这一遍测量不作数(机器被别的任务占满) */
const MIN_TIMELINE_RATE = 0.9;
const round = (x, n = 3) => (x === null || x === undefined || !Number.isFinite(x) ? x : +x.toFixed(n));
/** 把采样里每个元素按片段(元素上的 data-pc-audio-clip)归类;两种来源(入库产物、浏览器合成)都认 */
function analyse(trace, truth) {
  const byId = new Map([[truth.kbd.id, 'kbd'], [truth.notif.id, 'notif'], [truth.av.id, 'av'], ...(truth.extra ? [[truth.extra.id, 'extra']] : [])]);
  const clips = { kbd: truth.kbd, notif: truth.notif, av: truth.av, extra: truth.extra };
  const per = { kbd: [], notif: [], av: [], extra: [] };
  for (const s of trace) for (const el of s.els) {
    const key = byId.get(el.clip);
    if (!key) continue;
    const c = clips[key];
    per[key].push({ w: s.w, t: s.t, playing: s.playing, ...el, expect: s.t - c.start + c.off });
  }
  return per;
}
/** 这一拍这个元素真的在出声:时间轴在播、元素没暂停、有数据可放、不在 seek、音量不为 0、没被静音 */
const audible = (x) => x.playing && !x.paused && x.ready >= 3 && !x.seeking && x.vol > 0 && !x.muted;
/**
 * 对齐。dev = 元素位置 − 应在位置(负 = 声音落后于播放头)。
 * - 起播前就挂着的元素(mounted):|dev| ≤ ALIGN_SEC 的采样占 ≥ 90%。
 * - 播放中才挂上的元素(lateStart):起声晚的那一截是元素加载的时间,不是漂移 —— 中位数落在 [−LATE_START_SEC, +0.05],
 *   且 ≥ 90% 的采样离中位数不超过 STEADY_SEC(一路 1:1 往前走,没有跳、没有重来)。
 */
function alignment(samples, { lateStart = false } = {}) {
  const a = samples.filter(audible);
  if (!a.length) return { n: 0, pass: false };
  const dev = a.map((x) => x.ct - x.expect);
  const sorted = [...dev].sort((p, q) => p - q);
  const median = sorted[sorted.length >> 1];
  const within = dev.filter((d) => Math.abs(d) <= ALIGN_SEC).length / a.length;
  const steady = dev.filter((d) => Math.abs(d - median) <= STEADY_SEC).length / a.length;
  const pass = lateStart ? (median >= -LATE_START_SEC && median <= 0.05 && steady >= 0.9) : within >= 0.9;
  return { n: a.length, pass, within: round(within), median: round(median), steady: round(steady), min: round(sorted[0]), max: round(sorted[sorted.length - 1]) };
}
/**
 * 事件是否被听到。判定不靠实时采样:
 *   「听到」= 元素在出声的拍里有落在这个事件的媒体时间窗口 [E-0.02, E+0.12] 的,**并且**元素播的那份字节解码后这个位置上有能量(energyOf)。
 * 位置跳过了某个事件(seek、从头重来)它就没有拍落在窗口里,算漏;播的那份声音里这个位置是空的,也算漏。
 * 实时采样(captureStream)在窗口里读到能量的事件数另记在 live 里,只作旁证 —— 采集音轨有时不出数据,不能拿它当判据。
 */
function heardEvents(samples, clip, energyOf, { after = -Infinity } = {}) {
  const on = samples.filter(audible);
  if (!on.length) return { eligible: 0, heard: [], missed: [], live: 0 };
  const firstCt = Math.min(...on.map((x) => x.ct));
  const lastCt = Math.max(...on.map((x) => x.ct));
  const heard = [], missed = [];
  let live = 0;
  clip.events.forEach((E, i) => {
    if (E < Math.max(after, firstCt + 0.03) || E + 0.12 > lastCt) return; // 这一遍没播到的不判
    const win = on.filter((x) => x.ct >= E - 0.02 && x.ct <= E + 0.12);
    (win.length && energyOf(i) >= THR ? heard : missed).push(+E.toFixed(3));
    if (win.some((x) => x.rms !== null && x.rms >= THR)) live++;
  });
  return { eligible: heard.length + missed.length, heard, missed, live };
}
/** 解码结果 → 「第 i 个事件位置上的能量」(同一段播过几份字节就取最小的;没有解码结果给 0) */
const energyIn = (srcE, clip) => (i) => { const got = (srcE?.[clip.id] ?? []).filter((g) => !g.error); return got.length ? Math.min(...got.map((g) => g.rms[i] ?? 0)) : 0; };
const maxRms = (samples) => Math.max(0, ...samples.filter((x) => x.rms !== null).map((x) => x.rms));
/** 这一遍播放里时间轴相对墙钟走得多快(从播放头第一次动起算;起步之前的等待另记) */
function timelinePace(trace) {
  const p = trace.filter((s) => s.playing);
  if (p.length < 5) return { rate: null, startStallMs: null, wallMs: 0 };
  const first = p.find((s) => s.t > p[0].t + 1e-9);
  if (!first) return { rate: 0, startStallMs: round(p[p.length - 1].w - p[0].w, 0), wallMs: 0 };
  const last = p[p.length - 1];
  const wall = (last.w - first.w) / 1000;
  return { rate: wall > 0.3 ? round((last.t - first.t) / wall) : null, startStallMs: round(first.w - p[0].w, 0), wallMs: round(last.w - first.w, 0) };
}
/** 同一个元素在出过声之后又重新加载了几次(播放中重新加载 = 声音断一下) */
function reloadsWhilePlaying(samples) {
  const seen = new Map();
  let n = 0;
  for (const x of samples) {
    const prev = seen.get(x.el);
    if (prev && x.playing && x.loads > prev.loads) n += x.loads - prev.loads;
    if (prev || audible(x)) seen.set(x.el, { loads: x.loads });
  }
  return n;
}

/* ================================================================== 套件 */
const retries = [];
/**
 * 量一遍;带时间的断言没过、或这一遍时间轴走得太慢(测量条件不成立)时整段重量,最多 3 遍。
 * 每次重量都打一行 RETRY 并记进结果的 retries(不藏);不带时间的断言(来源、从头重来、标记、暂停即停)没过不会因此重量。
 */
async function phase(name, run, max = 3) {
  for (let i = 1; ; i++) {
    const r = await run();
    const badTiming = r.checks.filter((c) => !c.ok && c.timing).map((c) => c.name);
    if (i < max && (r.invalid || badTiming.length)) {
      const why = r.invalid ?? `带时间的断言没过:${badTiming.join(';')}`;
      retries.push({ phase: name, attempt: i, why, failed: r.checks.filter((c) => !c.ok).map((c) => c.name), pace: r.pace });
      console.log(`RETRY ${name} 第 ${i} 遍不作数:${why} ${JSON.stringify(r.pace ?? {})} ${JSON.stringify(r.checks.filter((c) => !c.ok).map((c) => c.evidence)).slice(0, 500)}`);
      continue;
    }
    if (r.invalid) check(false, `${name} 测量条件(时间轴速率 ≥ ${MIN_TIMELINE_RATE})`, { why: r.invalid, pace: r.pace, attempts: i });
    for (const c of r.checks) check(c.ok, c.name, i > 1 ? { ...c.evidence, attempt: i } : c.evidence);
    return r;
  }
}
/**
 * @param sources 三段声音各自应当是哪种来源:'product'(已入库的产物)或 'live'(浏览器当场合成的临时声音)
 */
async function runSuite(page, label, truth, { quick = false, source = 'product' } = {}) {
  const tag = (s) => `${label}:${s}`;
  const S = (fn, ...a) => P(page, fn, ...a);
  const shot = async (name) => { const f = path.join(OUT, `${label}-${name}.png`); await page.screenshot({ path: f }).catch(() => {}); return f; };
  const stopAll = () => S(() => { const s = window.__pcStore; s.actions.pause(); });
  const seek = (t) => S((x) => window.__pcStore.actions.seek(x), t);
  const playTo = (from, to) => S((a, b, ms) => window.__sv.playTo(a, b, ms), from, to, Math.round((to - from) * 4000 + 15_000));
  const waitT = (to, ms = 30_000) => S((b, m) => window.__sv.waitT(b, m), to, ms);
  let dumpN = 0;
  /** 收采样并落盘(排查用:<out>/trace-<形态>-<序号>.json),再接着采 */
  const collect = async () => {
    const t = await S(() => window.__sv.stop());
    try { fs.writeFileSync(path.join(OUT, `trace-${label}-${++dumpN}.json`), JSON.stringify(t)); } catch { /* 只是排查用 */ }
    await S(() => window.__sv.start());
    return t;
  };
  const C = (ok, name, evidence = {}, timing = false) => ({ ok: !!ok, name: tag(name), evidence, timing });
  const paceOf = (trace) => { const pace = timelinePace(trace); return { pace, invalid: pace.rate !== null && pace.rate < MIN_TIMELINE_RATE ? `时间轴只有墙钟的 ${pace.rate} 倍速` : undefined }; };
  await S(HARNESS);
  await S(() => window.__sv.start());
  const shots = {};
  const wanted = { [truth.kbd.id]: truth.kbd.events, [truth.notif.id]: truth.notif.events, [truth.av.id]: truth.av.events };
  /** 播的那份字节解码后各事件位置上的能量(每段播完后取;合成来源每次挂上是新地址,取的时候一并核) */
  let srcE = {};
  const decode = async () => { srcE = await S((w) => window.__sv.sourceEnergy(w), wanted); return srcE; };
  /** 实时采样这一路:每段声音采到过的最大能量(旁证;套件末尾要求三段都采到过) */
  const liveSeen = { kbd: 0, notif: 0, av: 0 };
  const noteLive = (a) => { for (const k of Object.keys(liveSeen)) liveSeen[k] = Math.max(liveSeen[k], maxRms((a[k] ?? []).filter(audible))); return a; };
  const liveOf = (xs) => round(maxRms(xs.filter(audible)), 4);

  /* ---- P1 从头播放(这一页第一次播放:舞台、解码都是冷的) ---- */
  await phase(tag('P1'), async () => {
    await stopAll(); await seek(0); await sleep(400);
    await collect();
    await playTo(0, 1.5);
    shots.playing = await shot('1-playing');
    await waitT(6.95); // 键盘声整段、提示音、声画卡都走过
    await stopAll();
    const t1 = await collect();
    const a1 = noteLive(analyse(t1, truth));
    await decode();
    const { pace, invalid } = paceOf(t1);
    const checks = [];
    const ctxState = await S(() => window.__sv.ctxState());
    checks.push(C(ctxState === 'running', 'P0 采样用的 AudioContext 在运行(能量采样有效)', { ctxState }));
    // 来源:这一形态下三段声音都应当是同一种来源(两种在线来源各跑一遍套件)
    const srcSeen = Object.fromEntries(['kbd', 'notif', 'av'].map((k) => [k, [...new Set(a1[k].filter(audible).map((x) => x.source))]]));
    checks.push(C(['kbd', 'notif', 'av'].every((k) => srcSeen[k].length === 1 && srcSeen[k][0] === source), `P1 三段声音的播放源都是${source === 'live' ? '浏览器当场合成的临时声音' : '已入库的产物'}`, { want: source, seen: srcSeen, urls: Object.fromEntries(['kbd', 'notif', 'av'].map((k) => [k, [...new Set(a1[k].filter(audible).map((x) => (x.src.startsWith('blob:') ? 'blob:' : x.src.replace(/^https?:\/\/[^/]+/, '').replace(/[0-9a-f]{56}(?=[0-9a-f]{8})/, '…').replace(/\?.*/, '?…'))))]])) }));
    const alK = alignment(a1.kbd);
    checks.push(C(alK.n > 5 && alK.pass, 'P1 kbd 播放时元素 currentTime 与时间轴对齐', alK, true));
    // 起播那一刻:声音不抢在播放头前面。舞台的第一拍到之前(播放头还没动)声音元素不该在放;第一拍之后的 1.5 秒里声音不超前
    const p1 = t1.filter((x) => x.playing);
    const beatAt = p1.find((x) => x.t > p1[0].t + 1e-9)?.w ?? Infinity;
    // 「第一拍」是舞台渲完起点那一帧,播放头要到第二拍才往前走一格:声音可以比播放头的第一次变化早一拍多一点(留 80 ms)
    const early = t1.filter((x) => x.playing && x.w < beatAt - 80).reduce((n, x) => n + x.els.filter((e) => !e.paused && e.ready >= 3).length, 0);
    const head = a1.kbd.filter((x) => x.playing && !x.paused && x.w >= beatAt && x.w - beatAt < 1500);
    const ahead = head.length ? Math.max(...head.map((x) => x.ct - x.expect)) : null;
    checks.push(C(early <= 1 && head.length > 5 && ahead <= ALIGN_SEC, 'P1 起播时声音不抢在播放头前面(等舞台的第一拍)', { playingBeforeFirstBeat: early, startStallMs: pace.startStallMs, samples: head.length, maxAheadSec: round(ahead) }, true));
    for (const key of ['notif', 'av']) {
      const al = alignment(a1[key], { lateStart: true });
      checks.push(C(al.n > 5 && al.pass, `P1 ${key} 播放时元素 currentTime 与时间轴对齐(播放中才挂上:起声 ≤ ${LATE_START_SEC}s、之后一路平稳)`, al, true));
    }
    const hk = heardEvents(a1.kbd, truth.kbd, energyIn(srcE, truth.kbd));
    checks.push(C(hk.eligible >= 20 && hk.heard.length / hk.eligible >= 0.95, 'P1 键盘声的事件都播到了,播的那份声音在这些位置上有能量', { eligible: hk.eligible, heard: hk.heard.length, missed: hk.missed.slice(0, 10), liveHeard: hk.live }, true));
    checks.push(C(a1.notif.filter(audible).length >= 10 && energyIn(srcE, truth.notif)(0) >= THR, 'P1 提示音片段播放时在出声(元素在放、放的那份声音有能量)', { audible: a1.notif.filter(audible).length, sourceRms: round(energyIn(srcE, truth.notif)(0), 4), liveRms: liveOf(a1.notif) }, true));
    checks.push(C(a1.av.filter(audible).length >= 20 && energyIn(srcE, truth.av)(0) >= THR, 'P6 声画卡内嵌声音播放时在出声(元素在放、放的那份声音有能量)', { audible: a1.av.filter(audible).length, sourceRms: round(energyIn(srcE, truth.av)(0), 4), liveRms: liveOf(a1.av) }, true));
    const reloads = Object.fromEntries(['kbd', 'notif', 'av'].map((k) => [k, reloadsWhilePlaying(a1[k])]));
    checks.push(C(Object.values(reloads).every((n) => n === 0), 'P1 出声之后元素没有在播放中重新加载(声音不断)', reloads));
    // 放到素材尽头不从头重播:元素放完(ended)之后不应再出现「在播、位置回到开头」的拍
    const restarted = ['kbd', 'notif', 'av'].map((k) => { const xs = a1[k]; const i = xs.findIndex((x) => x.ended); return i < 0 ? 0 : xs.slice(i).filter((x) => x.playing && !x.paused && x.ct < 0.3 && x.expect > 0.5).length; });
    checks.push(C(restarted.every((n) => n === 0), 'P1 放到素材尽头的元素没有从头重播', { kbd: restarted[0], notif: restarted[1], av: restarted[2] }));
    // 刚挂上的一两拍是 idle / pending(还没有声音源);canplay 之后标记才翻成 ready,比元素真的开始出声晚一次重渲染(留 3 拍)。不许出现 error
    checks.push(C(a1.av.filter(audible).length > 5 && a1.av.filter((x) => audible(x) && x.cstate !== 'ready').length <= 3 && !a1.av.some((x) => x.cstate === 'error'), 'P6 声画卡元素出声时 data-card-audio-state 为 ready', { states: [...new Set(a1.av.map((x) => x.cstate))], whileAudible: [...new Set(a1.av.filter(audible).map((x) => x.cstate))] }, true));
    checks.push(C(truth.clipCount === 4 && truth.avDuplicateAudioClips === 0, 'P6 声画卡的声音与画面是同一个片段(项目里只有 4 个片段:打字卡、键盘声、提示音、声画卡;没有第二个引用它声音的片段)', { clipCount: truth.clipCount, avDuplicateAudioClips: truth.avDuplicateAudioClips }));
    // 播的那份声音本身(解码它的字节):每个事件的位置上有能量 —— 两种来源同一条断言,不依赖实时采样的时序
    for (const [key, clip, need] of [['kbd', truth.kbd, 0.95], ['notif', truth.notif, 1], ['av', truth.av, 1]]) {
      const got = srcE[clip.id] ?? [];
      const ok = got.length > 0 && got.every((g) => !g.error && g.rms.filter((r) => r >= THR).length / g.rms.length >= need && (source === 'live' ? g.kind === 'blob' : g.kind === 'url'));
      const good = got.filter((g) => !g.error);
      checks.push(C(ok, `P1 ${key} 播的那份声音解码后,事件位置上有能量(来源:${source === 'live' ? '合成' : '产物'})`, { copies: got.length, errors: got.filter((g) => g.error).map((g) => g.error), kind: [...new Set(good.map((g) => g.kind))], duration: round(good[0]?.duration), events: clip.events.length, withEnergy: good.length ? Math.min(...good.map((g) => g.rms.filter((r) => r >= THR).length)) : 0, minRms: good.length ? round(Math.min(...good.flatMap((g) => g.rms)), 4) : null }));
    }
    return { checks, pace, invalid };
  });

  /** 实时采样这一路的收尾:哪段声音整个套件里都没采到能量,就把它单独再播几遍(每遍元素都是新挂的),最后三段都得采到过 */
  const liveTopUp = async () => {
    let extraPlays = 0;
    for (const [key, clip] of [['kbd', truth.kbd], ['notif', truth.notif], ['av', truth.av]]) {
      for (let i = 0; i < 3 && liveSeen[key] < THR; i++) {
        extraPlays++;
        await stopAll(); await seek(7.5); await sleep(300); // 播放头在所有声音片段之外:元素卸掉,下一遍重新挂
        await collect();
        await playTo(Math.max(0, clip.start - 0.2), Math.min(clip.end, clip.start + 1.2) - 0.02);
        await stopAll();
        noteLive(analyse(await collect(), truth));
      }
    }
    check(Object.values(liveSeen).every((v) => v >= THR), tag('实时采样(captureStream):三段声音都从元素上采到过能量'), { maxRms: Object.fromEntries(Object.entries(liveSeen).map(([k, v]) => [k, round(v, 4)])), extraPlays });
  };

  if (quick) { await liveTopUp(); await S(() => window.__sv.stop()); return shots; }

  /* ---- P2 暂停 ---- */
  await seek(0.4); await sleep(300);
  await collect();
  await playTo(0.4, 1.3);
  const pausedAt = await S(() => { const s = window.__pcStore; const t0 = performance.now(); s.actions.pause(); return t0; });
  await sleep(700);
  const t2 = await collect();
  const before = analyse(t2.filter((s) => s.w <= pausedAt), truth).kbd.filter(audible);
  const after = t2.filter((s) => s.w > pausedAt + 300);
  const stillPlaying = after.filter((s) => s.els.some((e) => !e.paused));
  const stillLoud = after.filter((s) => s.els.some((e) => e.rms !== null && e.rms >= THR));
  check(before.length > 10 && after.length > 10 && stillPlaying.length === 0 && stillLoud.length === 0, tag('P2 暂停后 300 ms 内所有声音元素停下、能量落到阈值以下'), { audibleBefore: before.length, samplesAfter: after.length, stillPlaying: stillPlaying.length, stillLoud: stillLoud.length });

  /* ---- P3 拖动(真实指针拖卡尺) ---- */
  await stopAll();
  const geo = await S(() => { const r = document.querySelector('[data-pc="ruler"]').getBoundingClientRect(); return { x: r.left, y: r.top + r.height / 2, w: r.width }; });
  // 卡尺的 x 与时间:用播放头现在的位置标定
  const calib = async () => S(() => { const ph = document.querySelector('[data-pc="playhead"]').getBoundingClientRect(); return { x: ph.left + ph.width / 2, t: window.__pcStore.getState().t }; });
  await seek(0); await sleep(150);
  const c0 = await calib();
  await seek(4); await sleep(150);
  const c4 = await calib();
  const pxPerSec = (c4.x - c0.x) / 4;
  const xAt = (t) => c0.x + t * pxPerSec;
  await collect();
  await page.mouse.move(xAt(0.5), geo.y);
  await page.mouse.down();
  for (let i = 0; i <= 24; i++) {
    await page.mouse.move(xAt(0.5 + (i / 24) * 2.0), geo.y, { steps: 2 });
    await sleep(25);
  }
  await sleep(150);
  const midDrag = await S(() => window.__sv.snapshot());
  await page.mouse.up();
  await sleep(300);
  const t3 = await collect();
  const playingDuringDrag = t3.filter((s) => s.els.some((e) => !e.paused));
  const tRelease = await S(() => window.__pcStore.getState().t);
  check(midDrag > 20 && playingDuringDrag.length === 0, tag('P3 拖动卡尺途中没有声音元素在播放'), { samples: t3.length, playingSamples: playingDuringDrag.length });
  check(Math.abs(tRelease - 2.5) < 0.2, tag('P3 松手后播放头停在指针处'), { tRelease });
  // 松手后元素停在指针对应的素材位置(暂停态精确对齐),不在 0
  const settle = analyse(t3.slice(-5), truth).kbd;
  check(settle.length > 0 && settle.every((x) => x.paused && Math.abs(x.ct - x.expect) <= 0.05), tag('P3 松手后声音元素停在指针对应的位置'), { samples: settle.length, ct: round(settle.at(-1)?.ct), expect: round(settle.at(-1)?.expect) });
  shots.drag = await shot('3-after-drag');

  /* ---- P4 从片段中间开始播放 ---- */
  const MID = 1.6; // 键盘声片段中间
  const startMedia = MID - truth.kbd.start + truth.kbd.off;
  await stopAll(); await seek(MID); await sleep(700);
  const visualText = await Promise.all(page.frames().map((f) => f.evaluate(() => [...document.querySelectorAll('h1')].map((h) => h.textContent).join('')).catch(() => '')));
  const wantText = TEXT.slice(0, Math.floor((MID * 1000) / 90));
  check(visualText.some((x) => x === wantText), tag('P4 画面:停在 1.6 秒时打字机已打到第 17 个字(不是从头重打)'), { want: wantText, got: visualText.filter(Boolean) });
  await phase(tag('P4'), async () => {
    await stopAll(); await seek(MID); await sleep(500);
    await collect();
    await playTo(MID, MID + 1.8);
    await stopAll();
    const t4 = await collect();
    const a4 = noteLive(analyse(t4, truth));
    await decode();
    const { pace, invalid } = paceOf(t4);
    const checks = [];
    // 不从头重来:凡是「没暂停、有数据」的拍,位置都不早于中间位置(不带时间:重来一次就是没过,不重量)
    const live4 = a4.kbd.filter((x) => x.playing && !x.paused && x.ready >= 3);
    const minCt = live4.length ? Math.min(...live4.map((x) => x.ct)) : null;
    checks.push(C(live4.length > 10 && minCt >= startMedia - ALIGN_SEC && minCt > 0.5, 'P4 从片段中间播放:currentTime 接着中间位置,不回到 0', { startMedia: round(startMedia), firstCt: round(live4[0]?.ct), minCt: round(minCt), samples: live4.length }));
    const al4 = alignment(a4.kbd);
    checks.push(C(al4.n > 10 && al4.pass, 'P4 从中间播放后一路对齐', al4, true));
    const h4 = heardEvents(a4.kbd, truth.kbd, energyIn(srcE, truth.kbd), { after: startMedia - 0.02 });
    checks.push(C(h4.eligible >= 8 && h4.missed.length === 0 && h4.heard.every((e) => e >= startMedia - 0.05), 'P4 中间播放时听到的都是中间位置之后的事件,且没有漏', { eligible: h4.eligible, heard: h4.heard.length, firstHeard: h4.heard[0], startMedia: round(startMedia), missed: h4.missed.slice(0, 8), liveHeard: h4.live }, true));
    checks.push(C(reloadsWhilePlaying(a4.kbd) === 0, 'P4 播放中元素没有重新加载', { reloads: reloadsWhilePlaying(a4.kbd) }));
    if (h4.eligible >= 8 && h4.live === 0) {
      // 实时采样整段是 0:旁路量一次元素的真实输出,分清是元素没出声还是采集音轨不出数据
      await stopAll(); await seek(MID); await sleep(300);
      const measuring = S((id) => window.__sv.elementOutput(id, 1200), truth.kbd.id);
      await sleep(80);
      await S(() => window.__pcStore.actions.play());
      const out = await measuring;
      await stopAll();
      console.log(`DIAG ${tag('P4')} 实时采样读到 0,旁路量元素输出:${JSON.stringify(out)} recaps=${Math.max(0, ...a4.kbd.map((x) => x.recaps ?? 0))}`);
      checks.push(C(!out.error && out.peak >= THR, 'P4 实时采样读不到时,旁路(Web Audio 直接接元素)量到元素确实在出声', { peak: round(out.peak, 4), playingSamples: out.playingSamples, error: out.error }));
    }
    return { checks, pace, invalid };
  });
  // 声画卡中间:5.2 开始的片段,从 5.3 播
  await phase(tag('P6 中间'), async () => {
    await stopAll(); await seek(5.3); await sleep(500);
    await collect();
    await playTo(5.3, 5.8);
    await stopAll();
    const t4b = await collect();
    const a4b = noteLive(analyse(t4b, truth));
    const { pace, invalid } = paceOf(t4b);
    const from = 5.3 - truth.av.start + truth.av.off;
    const liveAv = a4b.av.filter((x) => x.playing && !x.paused && x.ready >= 3);
    const avMin = liveAv.length ? Math.min(...liveAv.map((x) => x.ct)) : null;
    const checks = [C(liveAv.length > 5 && avMin >= from - ALIGN_SEC && avMin > 0.05, 'P6 声画卡从中间播放:内嵌声音接着中间位置,不从头重来', { avMin: round(avMin), from: round(from), samples: liveAv.length })];
    const al = alignment(a4b.av);
    checks.push(C(al.n > 5 && al.pass, 'P6 声画卡从中间播放后对齐', al, true));
    return { checks, pace, invalid };
  });

  /* ---- P5 静音与恢复(真实右键菜单) ---- */
  const widths = await S((ids) => Object.fromEntries(ids.map((id) => [id, document.querySelector(`[data-clip-id="${id}"]`)?.getBoundingClientRect().width ?? null])), [truth.kbd.id, truth.notif.id, truth.av.id]);
  const menuMute = async (clipId, text) => {
    const box = await page.$eval(`[data-clip-id="${clipId}"]`, (el) => { const r = el.getBoundingClientRect(); return { x: r.left + Math.min(r.width / 2, 40), y: r.top + r.height / 2 }; });
    await page.mouse.click(box.x, box.y, { button: 'right' });
    await sleep(250);
    const clicked = await S((label) => {
      const items = [...document.querySelectorAll('[data-pc="tl-ctxmenu"] .pc-tl-ctxmenu-item')].filter((e) => e.textContent.trim() === label);
      if (!items.length) return false;
      items[0].click();
      return true;
    }, text);
    await sleep(250);
    return clicked;
  };
  const badgeOf = (id) => S((cid) => {
    const clip = document.querySelector(`[data-clip-id="${cid}"]`);
    const badges = [...document.querySelectorAll('[data-pc="clip-muted"]')];
    const own = clip?.querySelector('[data-pc="clip-muted"]') ?? badges.find((b) => (b.getAttribute('title') || '').includes(clip?.getAttribute('title')?.split('：')[0] ?? '\u0000'));
    return { attr: clip?.getAttribute('data-audio-muted') ?? null, badge: !!own, compact: !!own?.classList.contains('is-compact'), text: own?.textContent?.trim() ?? null, title: own?.getAttribute('title') ?? null, total: badges.length };
  }, id);
  await stopAll(); await seek(0); await sleep(300);
  const mutedKbd = await menuMute(truth.kbd.id, '静音片段');
  const bKbd = await badgeOf(truth.kbd.id);
  check(mutedKbd && bKbd.attr === 'true' && bKbd.badge && /已静音/.test(bKbd.text ?? ''), tag('P5 键盘声片段静音后:data-audio-muted 且时间轴有「已静音」标记'), { clicked: mutedKbd, width: widths[truth.kbd.id], ...bKbd });
  const mutedNotif = await menuMute(truth.notif.id, '静音片段');
  const bNotif = await badgeOf(truth.notif.id);
  check(mutedNotif && bNotif.attr === 'true' && bNotif.badge, tag('P5 提示音片段(窄)静音后有标记'), { clicked: mutedNotif, width: widths[truth.notif.id], compactVariantExpected: widths[truth.notif.id] < 76, ...bNotif });
  check(bNotif.compact === (widths[truth.notif.id] < 76), tag('P5 窄片段(<76px)用外置图标、宽片段用整块标记'), { width: widths[truth.notif.id], compact: bNotif.compact });
  const bAvBefore = await badgeOf(truth.av.id);
  check(!bAvBefore.attr, tag('P5 没静音的声画卡片段没有标记'), bAvBefore);
  await collect();
  await playTo(0.3, 1.7);
  shots.muted = await shot('2-muted-playing');
  await waitT(2.0);
  await stopAll();
  const t5 = await collect();
  const a5 = analyse(t5, truth);
  const swept = t5.filter((s) => s.playing).length;
  check(swept > 20 && a5.kbd.length === 0, tag('P5 静音的键盘声片段播放扫过时没有它的声音元素'), { playingSamples: swept, kbdElementSamples: a5.kbd.length });
  // 其他片段照常:播过声画卡
  await phase(tag('P5 其他片段'), async () => {
    await stopAll(); await seek(5.2); await sleep(400);
    await collect();
    await playTo(5.2, 6.1); await stopAll();
    const t5b = await collect();
    const a5b = noteLive(analyse(t5b, truth));
    await decode();
    return { ...paceOf(t5b), checks: [C(a5b.av.filter(audible).length >= 20 && energyIn(srcE, truth.av)(0) >= THR, 'P5 其他片段(声画卡)在别的片段静音时照常出声', { audible: a5b.av.filter(audible).length, sourceRms: round(energyIn(srcE, truth.av)(0), 4), liveRms: liveOf(a5b.av) }, true)] };
  });
  // 声画卡自己静音:参数面板的按钮
  await S((id) => window.__pcStore.actions.select([id]), truth.av.id);
  await openEdit(page);
  await page.waitForSelector('[data-pc="card-audio-controls"]', { visible: true, timeout: 15_000 });
  await S(() => { for (const b of document.querySelectorAll('[data-pc="card-audio-controls"] button')) if (b.textContent.trim() === '静音卡片') b.click(); });
  await sleep(300);
  const bAv = await badgeOf(truth.av.id);
  const avStill = await S((id) => !!window.__pcStore.getState().project.tracks.flatMap((t) => t.clips).find((c) => c.id === id && c.cardId === 'av-pulse'), truth.av.id);
  check(bAv.attr === 'true' && bAv.badge && avStill, tag('P5 声画卡静音:标记出现,画面片段还在'), { ...bAv, visualClipStillThere: avStill });
  await stopAll(); await seek(5.2); await sleep(300);
  await collect();
  await playTo(5.2, 6.1); await stopAll();
  const t5c = await collect();
  check(t5c.filter((s) => s.playing).length > 10 && analyse(t5c, truth).av.length === 0, tag('P5 静音后的声画卡片段没有声音元素'), { playingSamples: t5c.filter((s) => s.playing).length, avElementSamples: analyse(t5c, truth).av.length });
  // 恢复
  await stopAll();
  await S(() => { for (const b of document.querySelectorAll('[data-pc="card-audio-controls"] button')) if (b.textContent.trim() === '恢复声音') b.click(); });
  const rKbd = await menuMute(truth.kbd.id, '恢复片段声音');
  const rNotif = await menuMute(truth.notif.id, '恢复片段声音');
  const bK2 = await badgeOf(truth.kbd.id), bN2 = await badgeOf(truth.notif.id), bA2 = await badgeOf(truth.av.id);
  check(rKbd && rNotif && !bK2.attr && !bK2.badge && !bN2.attr && !bN2.badge && !bA2.attr && !bA2.badge && bA2.total === 0, tag('P5 恢复后:三个片段的标记都撤掉'), { bK2, bN2, bA2 });
  await phase(tag('P5 恢复'), async () => {
    await stopAll(); await seek(0.3); await sleep(300);
    await collect();
    await playTo(0.3, 1.8); shots.restored = await shot('3-restored-playing'); await stopAll();
    const t5d = await collect();
    const a5d = noteLive(analyse(t5d, truth));
    await decode();
    const k = a5d.kbd.filter(audible);
    const h5 = heardEvents(a5d.kbd, truth.kbd, energyIn(srcE, truth.kbd));
    const al = alignment(a5d.kbd);
    return { ...paceOf(t5d), checks: [
      C(k.length > 10 && h5.eligible >= 5 && h5.missed.length === 0, 'P5 恢复后键盘声重新出声', { audible: k.length, events: h5.eligible, heard: h5.heard.length, liveRms: liveOf(a5d.kbd) }, true),
      C(al.n > 10 && al.pass, 'P5 恢复后键盘声接着当前位置、对齐', al, true),
    ] };
  });
  await liveTopUp();
  await S(() => window.__sv.stop());
  return shots;
}

/* ================================================================== 主流程 */
let browser = null, dev = null, combo = null, hostedProxy = null, summary = { out: OUT };
/** 在线站点的代理把这些哈希的字节请求回成 404(「素材服务里没有这份文件」),逼在线页面改用浏览器合成的临时声音 */
const blockedHashes = new Set();

async function launchBrowser() {
  const { default: puppeteer } = await import('puppeteer');
  const { PROBE_CHROME_ARGS } = await import('./probe-chrome.mjs');
  return puppeteer.launch({ headless: true, protocolTimeout: 180_000, defaultViewport: { width: 1600, height: 900 },
    args: [...PROBE_CHROME_ARGS, '--no-first-run', '--hide-scrollbars', '--force-device-scale-factor=1', '--autoplay-policy=no-user-gesture-required', '--mute-audio', '--site-per-process',
      ...(process.env.PC_CHROME_ARGS ? process.env.PC_CHROME_ARGS.split(/\s+/).filter(Boolean) : [])] });
}
async function newPage(label) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(String(e?.message ?? e).slice(0, 200)));
  page.label = label;
  return page;
}
async function startDesktop() {
  const dir = path.join(TMP, 'desktop');
  for (const d of ['data', 'card-overrides', 'projects', 'work', 'tmp']) fs.mkdirSync(path.join(dir, d), { recursive: true });
  const env = {};
  Object.assign(env, { PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_EXPORT_DIR: dir, PROMPTCUT_DATA_DIR: path.join(dir, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir, 'card-overrides'),
    PROMPTCUT_PROJECTS_DIR: path.join(dir, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir, 'work'), PROMPTCUT_STREAMS: '0', TEMP: path.join(dir, 'tmp'), TMP: path.join(dir, 'tmp'), TMPDIR: path.join(dir, 'tmp') });
  dev = await startDevServer({ env, logFile: path.join(dir, 'vite.log'), port: BASE, log: (m) => console.log(`[dev] ${m}`) });
  console.log(`[dev] 桌面形态 ${dev.origin}`);
}
const portFree = (port) => new Promise((resolve) => { const s = net.createServer(); s.once('error', () => resolve(false)); s.listen(port, '127.0.0.1', () => s.close(() => resolve(true))); });

async function startOnlineSite() {
  const SITE = proxyOrigins(BASE + 3).editor; // 编辑器页 pc.localhost:<端口>,舞台 s1./s2.pc.localhost:<端口+1/+2>(同站跨源)
  for (const p of [BASE + 3, BASE + 4, BASE + 5, DOC_PORT, ASSET_PORT]) if (!(await portFree(p))) throw new Error(`端口 ${p} 被占用`);
  let DIST = arg('dist', null);
  if (!DIST) {
    DIST = path.join(TMP, 'dist-online');
    console.log(`[online] 构建在线页面到 ${DIST}`);
    const b = spawnSync(process.execPath, [viteBin(), 'build', '--mode', 'online', '--outDir', DIST, '--emptyOutDir', '--logLevel', 'error'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
    if (b.status !== 0) throw new Error(`在线构建失败:${String(b.stderr).slice(-600)}`);
  }
  DIST = path.resolve(DIST);
  const { startHostedCombo } = await import('../../server/hosted/combo.mjs');
  fs.mkdirSync(path.join(TMP, 'hosted'), { recursive: true });
  combo = await startHostedCombo({ dataDir: path.join(TMP, 'hosted'), docPort: DOC_PORT, assetPort: ASSET_PORT, host: '127.0.0.1',
    docPublicUrl: `ws://pc.localhost:${BASE + 3}/hosted/`, assetPublicUrl: `${SITE}/media/api/asset`, log: () => {} });
  // 共用的本机托管代理(`lib/hosted-proxy.mjs`,full 策略:同站跨源的三个源、策略头、`/media-s/`、运行配置);挡素材由钩子做
  const bytesRe = /^\/media\/api\/asset\/media\/([0-9a-f]{64})$/;
  hostedProxy = await startHostedProxy({ dist: DIST, basePort: BASE + 3, docPort: DOC_PORT, assetPort: ASSET_PORT, policy: 'full',
    intercept: ({ req, url }) => {
      const bytesOf = bytesRe.exec(url.pathname);
      if (bytesOf && blockedHashes.has(bytesOf[1]) && (req.method === 'GET' || req.method === 'HEAD')) return { status: 404, body: 'Not found', headers: { 'cache-control': 'no-store' } };
      return undefined;
    },
    responseHeaders: ({ url }) => (bytesRe.test(url.pathname) ? { 'cache-control': 'no-store' } : undefined) });
  return SITE;
}
const typeInto = async (page, sel, text) => { await page.waitForSelector(sel, { visible: true, timeout: 20_000 }); await page.click(sel); await page.$eval(sel, (el) => el.select()); await page.keyboard.press('Backspace'); if (text) await page.type(sel, text, { delay: 5 }); };
const textOf = (page, sel) => page.$eval(sel, (el) => el.textContent ?? '').catch(() => '');

async function enableCollab(creator, SITE) {
  await P(creator, () => window.dispatchEvent(new Event('pc-open-project-settings')));
  await creator.waitForSelector('[data-pc="collab-section"]', { visible: true, timeout: 20_000 });
  await creator.click('[data-pc="collab-toggle"]');
  await creator.waitForSelector('[data-pc="collab-where-hosted"]', { visible: true });
  await creator.click('[data-pc="collab-where-hosted"]');
  await typeInto(creator, '[data-pc="collab-hosted-url"]', `${SITE}/hosted/`);
  await creator.click('.pc-dialog-foot .pc-btn--primary');
  const status = await until('放云端开启完成', async () => { const t = await textOf(creator, '[data-pc="collab-status"]'); return t && !t.includes('正在设置') ? t : null; }, 90_000, 300);
  if (!check(status?.includes('多用户协作已开启。'), '创建者项目设置里开启「多用户协作」放云端(本机托管组合)', { status })) throw new Error('协作没开起来');
  await creator.waitForSelector('[data-pc="collab-invite-link"]', { timeout: 20_000 });
  const link = (await textOf(creator, '[data-pc="collab-invite-link"]')).trim();
  await creator.keyboard.press('Escape');
  return link;
}

try {
  if (MODE === 'desktop' || MODE === 'both') await startDesktop();
  else await startDesktop(); // 在线模式也要一台桌面版当创建者
  browser = await launchBrowser();
  const creator = await newPage('creator');
  await creator.goto(`${dev.origin}/?editor&nosetup=1`, { waitUntil: 'domcontentloaded', timeout: 180_000 });
  await until('桌面编辑器就绪', () => P(creator, () => !!window.__pcStore && !!document.querySelector('[data-pc="ruler"]')), 120_000, 300);
  await P(creator, () => { for (const b of document.querySelectorAll('.ais-dialog .ais-btn')) if (b.textContent?.trim() === '关闭') b.click(); });
  const truth = await buildScenario(creator);
  summary.truth = { kbdEvents: truth.kbd.events.length, notif: truth.notif.events, av: truth.av.events, start: [truth.kbd.start, truth.notif.start, truth.av.start] };
  check(truth.kbd.events.length >= 30 && !!truth.notif && !!truth.av, '场景:键盘声(≥30 个事件)、提示音、声画卡声音都已生成入库', summary.truth);

  if (MODE === 'desktop' || MODE === 'both') {
    summary.desktopShots = await runSuite(creator, 'desktop', truth);
    summary.desktopErrors = creator.errors.slice(0, 10);
  }
  if (MODE === 'desktop' || MODE === 'both') {
    /* ---- 第 7 条:含生成声音的项目「打包保存」后,在空数据目录打开,声音还在 ---- */
    const packed = await P(creator, async () => {
      const { packProcp } = await import('/src/editor/io/procp.ts');
      const r = await packProcp();
      const bytes = new Uint8Array(await r.blob.arrayBuffer());
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      return { b64: btoa(bin), size: bytes.length, missing: r.missing };
    });
    check(packed.size > 1000 && packed.missing.length === 0, '第7条:真实「打包保存」(packProcp)打出 .procp,没有缺失素材', { size: packed.size, missing: packed.missing });
    fs.writeFileSync(path.join(OUT, 'sound-project.procp'), Buffer.from(packed.b64, 'base64'));
    const dir2 = path.join(TMP, 'desktop-empty');
    for (const d of ['data', 'card-overrides', 'projects', 'work', 'tmp']) fs.mkdirSync(path.join(dir2, d), { recursive: true });
    const dev2 = await startDevServer({ env: { PROMPTCUT_NO_PORT_FILE: '1', PROMPTCUT_EXPORT_DIR: dir2, PROMPTCUT_DATA_DIR: path.join(dir2, 'data'), PROMPTCUT_CARD_OVERRIDES: path.join(dir2, 'card-overrides'),
      PROMPTCUT_PROJECTS_DIR: path.join(dir2, 'projects'), PROMPTCUT_WORK_DIR: path.join(dir2, 'work'), PROMPTCUT_STREAMS: '0', TEMP: path.join(dir2, 'tmp'), TMP: path.join(dir2, 'tmp'), TMPDIR: path.join(dir2, 'tmp') },
      logFile: path.join(dir2, 'vite.log'), port: BASE + 6, log: (m) => console.log('[dev2] ' + m) });
    try {
      const empty = path.join(dir2, 'media');
      const before = fs.existsSync(empty) ? fs.readdirSync(empty).filter((x) => !x.startsWith('.')).length : 0;
      const fresh = await newPage('reopen');
      await fresh.goto(dev2.origin + '/?editor&nosetup=1', { waitUntil: 'domcontentloaded', timeout: 180_000 });
      await until('空数据目录的编辑器就绪', () => P(fresh, () => !!window.__pcStore && !!document.querySelector('[data-pc="ruler"]')), 120_000, 300);
      const missingBefore = await Promise.all([truth.kbd.hash, truth.notif.hash, truth.av.hash].map((h) => fetch(dev2.origin + '/@media/' + h).then((r) => r.status)));
      const opened = await P(fresh, async (b64) => {
        const bin = atob(b64), bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        const { loadProcpFile } = await import('/src/editor/io/procp.ts');
        const project = await loadProcpFile(new Blob([bytes]));
        window.__pcStore.actions.loadProject(project);
        const p = window.__pcStore.getState().project;
        return { media: p.media.map((m) => ({ name: m.name, hash: m.hash, recipe: !!m.soundEffect, url: m.url })), cardAudio: p.tracks.flatMap((t) => t.clips).filter((c) => c.cardAudio).length, clips: p.tracks.flatMap((t) => t.clips).length };
      }, packed.b64);
      const statuses = await Promise.all([truth.kbd.hash, truth.notif.hash, truth.av.hash].map((h) => fetch(dev2.origin + '/@media/' + h).then(async (r) => ({ status: r.status, bytes: (await r.arrayBuffer()).byteLength }))));
      check(missingBefore.every((x) => x !== 200) && before === 0, '第7条:打开前空数据目录里没有这三份声音', { missingBefore, filesBefore: before });
      check(opened.media.length === 3 && opened.cardAudio === 1 && opened.clips === 4 && opened.media.filter((m) => m.recipe).length === 2, '第7条:打开 .procp 后项目完整(3 份声音素材、2 份带配方、1 个声画卡内嵌声音、4 个片段)', opened);
      check(statuses.every((x) => x.status === 200 && x.bytes > 44), '第7条:声音字节已落进新数据目录,/@media/<哈希> 取得到', statuses);
      await openEdit(fresh);
      summary.reopenShots = await runSuite(fresh, 'reopened', truth, { quick: true });
    } finally { dev2.stop(); }
  }
  if (MODE === 'online' || MODE === 'both') {
    const SITE = await startOnlineSite();
    console.log('[step] 在线站点已起 ' + SITE);
    // 开协作前先恢复到干净状态(静音都已恢复),让成员看到的与创建者一致
    const link = await enableCollab(creator, SITE);
    const code = String(link).split('invite=')[1];
    console.log('[step] 协作已开启,邀请码长度 ' + code.length);
    // 等素材上云
    const uploaded = await until('三份声音素材上传到本机托管组合', async () => {
      const q = await fetch(`${dev.origin}/api/media/upload-queue`).then((r) => r.json()).catch(() => null);
      const u = q?.queue;
      return u && !u.working && (u.items?.length ?? 0) === 0 && u.enqueued > 0 && u.done >= u.enqueued ? q : null;
    }, 120_000, 1000);
    summary.uploadQueue = uploaded;
    console.log('[step] 上传队列 ' + JSON.stringify(uploaded?.queue ?? null));
    /** 开一个在线成员页(新的浏览器上下文:自己的缓存、自己的身份),凭邀请链接加入,等到共享项目的声音素材与片段都在 */
    const joinMember = async (pageLabel, userName) => {
      const page = await newPage(pageLabel);
      page.on('console', (m) => { if (['error', 'warning'].includes(m.type())) console.log(`[${pageLabel} console ${m.type()}] ` + m.text().slice(0, 240)); });
      page.on('pageerror', (e) => console.log(`[${pageLabel} pageerror] ` + String(e?.message ?? e).slice(0, 240)));
      await page.goto(`${SITE}/editor#invite=${code}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
      await page.waitForSelector('[data-pc="join-invite-project"]', { visible: true, timeout: 60_000 });
      await typeInto(page, '[data-pc="join-username"]', userName);
      await page.click('[data-pc="join-submit"]');
      await page.waitForSelector('[data-pc="members-button"]', { visible: true, timeout: 90_000 });
      console.log(`[step] ${userName}已进入共享项目`);
      const ready = await until(`${userName}页看到共享项目的全部声音素材与片段`, () => P(page, () => {
        const p = window.__pcStore?.getState().project;
        return p && p.media.length >= 3 && p.tracks.flatMap((t) => t.clips).length >= 4 ? p.media.length : null;
      }), 90_000, 500);
      return { page, ready };
    };
    const { page: member, ready } = await joinMember('member', '成员');
    check(!!ready, '在线成员页收到共享项目(声音素材与片段都在)', { media: ready });
    const isOnline = await P(member, () => location.pathname.startsWith('/editor'));
    check(isOnline, '成员页是在线浏览器模式(/editor)', { url: member.url().replace(/#.*/, '') });
    // 真值:成员页上的哈希与创建者一致
    summary.onlineShots = await runSuite(member, 'online', truth, { source: 'product' });
    summary.onlineErrors = member.errors.slice(0, 10);
    /* ---- 第 7 条:协作项目里 Agent 生成声音,另一端(在线成员页)听得到 ---- */
    const baseline = await P(member, () => window.__pcStore.getState().project.media.map((m) => m.hash));
    const called = await fetch(dev.origin + '/api/mcp/call', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tool: 'sound_generate', agent: 'verify-agent', args: { preset: 'notification', start: 6.2, requestId: 'verify-agent-sound-1', name: 'agent-提示音', params: { frequency: 1320 } } }) }).then((r) => r.json()).catch((e) => ({ ok: false, error: String(e) }));
    check(called.ok === true, '第7条:Agent 经 sound_generate 工具(与 MCP 同一入口)在协作项目里生成提示音', { ok: called.ok, error: called.error, result: JSON.stringify(called.result ?? '').slice(0, 200) });
    const fresh = await until('成员页收到 Agent 生成的新声音素材与片段', () => P(member, (known) => {
      const p = window.__pcStore.getState().project;
      const m = p.media.find((x) => x.soundEffect?.recipe?.params?.frequency === 1320 && !known.includes(x.hash));
      const c = m && p.tracks.flatMap((t) => t.clips).find((x) => x.mediaId === m.id);
      return c ? { id: c.id, hash: m.hash, start: c.start, end: c.end, off: c.mediaOffset ?? 0, events: m.soundEffect.recipe.events.map((e) => e.frame / 48000) } : null;
    }, baseline), 90_000, 500);
    if (fresh) {
      await P(member, HARNESS);
      await P(member, () => window.__sv.start());
      let srcUsed = null;
      await phase('第7条:另一端播放 Agent 生成的声音', async () => {
        await P(member, () => window.__pcStore.actions.pause());
        await P(member, () => { window.__sv.stop(); return window.__sv.start(); });
        await P(member, (a, b) => window.__sv.playTo(a, b, 20_000), fresh.start - 0.1, Math.min(fresh.end, fresh.start + 0.75));
        await P(member, () => window.__pcStore.actions.pause());
        const tr = await P(member, () => window.__sv.stop());
        try { fs.writeFileSync(path.join(OUT, 'trace-online-agent.json'), JSON.stringify(tr)); } catch { /* 只是排查用 */ }
        await P(member, () => window.__sv.start());
        const own = analyse(tr, { ...truth, extra: fresh }).extra;
        const al = alignment(own, { lateStart: true });
        const loud = maxRms(own.filter(audible));
        const dec = await P(member, (w) => window.__sv.sourceEnergy(w), { [fresh.id]: fresh.events });
        const srcRms = energyIn(dec, fresh)(0);
        srcUsed = own.find((x) => audible(x) && x.src)?.src ?? srcUsed;
        const pace = timelinePace(tr);
        return { pace, invalid: pace.rate !== null && pace.rate < MIN_TIMELINE_RATE ? `时间轴只有墙钟的 ${pace.rate} 倍速` : undefined, checks: [
          { ok: own.filter(audible).length >= 10 && al.pass && srcRms >= THR, name: '第7条:另一端(在线成员页)播放 Agent 生成的声音:元素在播、currentTime 对齐、放的那份声音有能量', evidence: { samples: own.length, ...al, sourceRms: round(srcRms, 4), liveRms: round(loud, 4), source: [...new Set(own.filter(audible).map((x) => x.source))] }, timing: true },
        ] };
      });
      const sameBytes = await P(member, async (u) => { const r = await fetch(u); return { status: r.status, bytes: (await r.arrayBuffer()).byteLength }; }, srcUsed).catch((e) => ({ error: String(e) }));
      check(sameBytes.status === 200 && sameBytes.bytes > 44, '第7条:成员页播放用的地址(素材服务)取得到 Agent 生成的 WAV', sameBytes);
      await P(member, () => window.__sv.stop());
    }
    /*
     * ---- 在线页面的另一种声音来源:浏览器合成的临时声音 ----
     * 把三份声音的字节在代理上挡成「素材服务里没有」(项目里的记录都还在),同一个成员页、同一套断言再跑一遍:
     * 键盘声、提示音按配方在浏览器里合成,声画卡由浏览器执行它的 audio() 合成;播放、暂停、拖动、从中间开始、静音与恢复
     * 都要和入库产物那一遍一样。
     */
    for (const h of [truth.kbd.hash, truth.notif.hash, truth.av.hash]) blockedHashes.add(h);
    console.log('[step] 三份声音的字节已在代理上挡掉;另开一个成员页(没有这三份声音的任何缓存)');
    summary.onlineErrors = member.errors.slice(0, 10);
    await member.close().catch(() => {});
    const { page: member2, ready: ready2 } = await joinMember('member-live', '成员二');
    check(!!ready2, '第二个在线成员页收到共享项目(三份声音的字节在素材服务里取不到)', { media: ready2, blocked: blockedHashes.size });
    summary.onlineLiveShots = await runSuite(member2, 'online-live', truth, { source: 'live' });
    summary.onlineLiveErrors = member2.errors.slice(0, 10);
  }
} catch (e) {
  fails.push(`中断:${String(e?.message ?? e).slice(0, 300)}`);
  console.error(e);
} finally {
  try { await browser?.close(); } catch { /* 已关 */ }
  try { dev?.stop(); } catch { /* 已关 */ }
  try { await hostedProxy?.close(); } catch { /* 已关 */ }
  try { await combo?.close?.(); } catch { /* 已关 */ }
  if (!KEEP) { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 留着 */ } }
}
summary.ok = fails.length === 0;
summary.fails = fails;
summary.retries = retries;
summary.checks = results.length;
fs.writeFileSync(path.join(OUT, `result-${MODE}.json`), JSON.stringify({ ...summary, results }, null, 2));
console.log(JSON.stringify({ ok: summary.ok, checks: results.length, fails, retries: retries.length }));
process.exit(summary.ok ? 0 : 1);
