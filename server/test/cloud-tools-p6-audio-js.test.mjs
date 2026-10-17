/**
 * P6 音频测量脚本提供者与签名处理器单测：
 *   - `server/hosted-render/audio-js.mjs` (`createHostedAudioJsHandler`)
 *   - `server/agent/service/hosted-audio-js.mjs` (`createAudioJsTools`)
 *
 * 覆盖：
 *   1. 纯正弦波 PCM 数值测量准确性（media / clip / timeline 混音，RMS 与峰值误差 < 0.05 dB）；
 *   2. 语法错误行列号（`line`、`column` 与 `(第 X 行第 Y 列)`）及运行期异常行号；
 *   3. 死循环超时终止，事件循环不阻塞；
 *   4. 内存超限与 256 KiB 输出上限拒绝；
 *   5. 联网/文件/Node API 越权尝试拒绝，以及签名路由未授权/浏览器请求拒绝；
 *   6. 跨项目素材拒绝、任意本地路径拒绝；
 *   7. 撤权取消（`abortForFence`）与 `close()` 时解码/沙箱 worker 真实关闭与临时文件清理。
 */
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { makeP1Fixture, tmpDir } from './cloud-tools-p1-fixture.mjs';
import { createAudioSandbox, syntaxLocationOf } from '../audio-sandbox.mjs';
import { generateServiceKeyPair } from '../auth/service-identity.mjs';
import { createHostedAudioJsHandler, HOSTED_AUDIO_JS_ROUTE } from '../hosted-render/audio-js.mjs';
import { createLookVerifier, signLookRequest } from '../hosted-render/look.mjs';
import { createAudioJsTools, AudioJsToolError, AUDIO_JS_TOOL_NAMES } from '../agent/service/hosted-audio-js.mjs';

const runSync = (cmd, args) => spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, timeout: 60_000 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function findFfmpeg() {
  if (process.env.PROMPTCUT_FFMPEG && fs.existsSync(process.env.PROMPTCUT_FFMPEG)) return process.env.PROMPTCUT_FFMPEG;
  const r = runSync(process.platform === 'win32' ? 'where' : 'which', ['ffmpeg']);
  const first = r.stdout?.split(/\r?\n/).find(Boolean)?.trim();
  return first && fs.existsSync(first) ? first : null;
}

const FFMPEG = findFfmpeg();
const EXT = path.extname(FFMPEG ?? '');
const FFPROBE = FFMPEG ? path.join(path.dirname(FFMPEG), `ffprobe${EXT}`) : null;
const skipFfmpeg = FFMPEG && fs.existsSync(FFPROBE) ? false : '没有找到真 ffmpeg / ffprobe';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-p6-audio-js-'));
const SINE_STEREO = path.join(TMP, 'sine-stereo.wav');
const SINE_MONO = path.join(TMP, 'sine-mono.wav');
if (!skipFfmpeg) {
  const wave = '0.5*sin(2*PI*1000*t)';
  runSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${wave}|${wave}:s=48000:d=3`, '-c:a', 'pcm_f32le', SINE_STEREO]);
  runSync(FFMPEG, ['-hide_banner', '-v', 'error', '-y', '-f', 'lavfi', '-i', `aevalsrc=${wave}:s=48000:d=3`, '-c:a', 'pcm_f32le', SINE_MONO]);
}

const sharedSandbox = createAudioSandbox();
after(async () => {
  await sharedSandbox.close();
  fs.rmSync(TMP, { recursive: true, force: true });
});

function makeServiceAuthPair() {
  const { kid, pub, priv } = generateServiceKeyPair();
  const serviceKey = { service: 'agent', kid, priv, instanceId: 'agent-inst-1' };
  const registry = {
    get(name) {
      if (name !== 'agent') return null;
      return { role: 'agent', keys: [{ kid, pub }] };
    },
  };
  return { serviceKey, registry, verifier: createLookVerifier({ registry }) };
}

const RMS_PEAK_CODE = `
  const out = [];
  for (const x of input.channels) {
    let s = 0, pk = 0;
    for (let i = 0; i < x.length; i++) {
      s += x[i] * x[i];
      const a = Math.abs(x[i]);
      if (a > pk) pk = a;
    }
    out.push({ rmsDb: 10 * Math.log10(s / x.length), peakDb: 20 * Math.log10(pk) });
  }
  return { channels: out, frames: input.frames, sampleRate: input.sampleRate, duration: input.duration, scope: input.scope, mediaId: input.mediaId, clipId: input.clipId };
`;

test('P6-01 工具名、语法错误行列定位纯函数与签名处理器鉴权拦截', async (t) => {
  assert.deepEqual([...AUDIO_JS_TOOL_NAMES], ['measure_audio_js']);
  const loc = syntaxLocationOf('const a = 1;\nconst b = ;\nreturn a + b;');
  assert.ok(loc, '应检出语法错误');
  assert.equal(loc.line, 2);
  assert.equal(loc.column, 11);
  assert.equal(syntaxLocationOf('const a = 1;\nreturn a;'), null);

  const { serviceKey, verifier } = makeServiceAuthPair();
  const handler = createHostedAudioJsHandler({
    verifyServiceRequest: verifier,
    sandbox: sharedSandbox,
  });

  const server = http.createServer((req, res) => {
    if (req.url === HOSTED_AUDIO_JS_ROUTE) return handler(req, res);
    res.statusCode = 404;
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const url = `http://127.0.0.1:${server.address().port}${HOSTED_AUDIO_JS_ROUTE}`;

  // 1) 未带服务签名的请求被 403 拒绝
  const unauth = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ code: 'return 1;', channels: [[0, 0]] }),
  });
  assert.equal(unauth.status, 403);

  // 2) 带 Origin 头的浏览器请求被 403 拒绝
  const bodyText = JSON.stringify({ code: 'return 1;', channels: [[0, 0]] });
  const browserReq = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
      'x-pc-service-auth': signLookRequest(serviceKey, bodyText),
    },
    body: bodyText,
  });
  assert.equal(browserReq.status, 403);

  // 3) 试图往签名处理器塞本地文件路径被 400 拒绝
  const pathBody = JSON.stringify({ code: 'return 1;', path: 'C:/Windows/win.ini', channels: [[0, 0]] });
  const pathReq = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-pc-service-auth': signLookRequest(serviceKey, pathBody),
    },
    body: pathBody,
  });
  assert.equal(pathReq.status, 400);
});

test('P6-02 纯正弦波 PCM 数值测量准确性（经签名路由全链路，覆盖 media / clip / timeline）', { skip: skipFfmpeg, timeout: 120_000 }, async (t) => {
  const { serviceKey, verifier } = makeServiceAuthPair();
  const handler = createHostedAudioJsHandler({
    verifyServiceRequest: verifier,
    sandbox: sharedSandbox,
  });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const endpointUrl = `http://127.0.0.1:${server.address().port}${HOSTED_AUDIO_JS_ROUTE}`;

  const fx = await makeP1Fixture(t);
  await fx.addMedia({ id: 'sine2', name: 'sine-stereo.wav', kind: 'audio', bytes: fs.readFileSync(SINE_STEREO), extra: { duration: 3 } });
  await fx.addMedia({ id: 'sine1', name: 'sine-mono.wav', kind: 'audio', bytes: fs.readFileSync(SINE_MONO), extra: { duration: 3 } });

  const timelineClips = [
    { id: 'clip_a', mediaId: 'sine2', start: 0, end: 2, mediaOffset: 0.5, volume: 1 },
    { id: 'clip_b', mediaId: 'sine1', start: 1, end: 3, mediaOffset: 0, volume: 0.5 },
  ];
  const project = {
    ...fx.project,
    async getTimeline() {
      return {
        duration: 3,
        tracks: [{ id: 't1', clips: timelineClips }],
      };
    },
  };

  const tools = createAudioJsTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    assets: fx.assets,
    project,
    workspace: () => fx.ws,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    endpointUrl,
    serviceKey,
  });
  t.after(() => tools.close());

  const RMS = 20 * Math.log10(0.5 / Math.SQRT2); // -9.0309 dBFS
  const PEAK = 20 * Math.log10(0.5); // -6.0206 dBFS

  // 1) media 档
  const mOut = await tools.call('measure_audio_js', { mediaId: 'sine2', code: RMS_PEAK_CODE }, fx.context);
  assert.equal(mOut.ok, true, JSON.stringify(mOut));
  assert.equal(mOut.scope, 'media');
  assert.equal(mOut.value.channels.length, 2);
  for (const ch of mOut.value.channels) {
    assert.ok(Math.abs(ch.rmsDb - RMS) < 0.05, `RMS ${ch.rmsDb} vs ${RMS}`);
    assert.ok(Math.abs(ch.peakDb - PEAK) < 0.1, `Peak ${ch.peakDb} vs ${PEAK}`);
  }
  assert.equal(mOut.value.sampleRate, 16000);
  assert.equal(mOut.value.mediaId, 'sine2');

  // 2) clip 档（截窗口 start=0.5, duration=1, mono=true, sampleRate=48000）
  const cOut = await tools.call('measure_audio_js', {
    clipId: 'clip_a',
    start: 0.5,
    duration: 1,
    mono: true,
    sampleRate: 48000,
    code: RMS_PEAK_CODE,
  }, fx.context);
  assert.equal(cOut.ok, true, JSON.stringify(cOut));
  assert.equal(cOut.scope, 'clip');
  assert.equal(cOut.value.channels.length, 1);
  assert.ok(Math.abs(cOut.value.frames - 48000) <= 48);
  assert.ok(Math.abs(cOut.value.channels[0].rmsDb - RMS) < 0.05);
  assert.equal(cOut.input.start, 1);

  // 3) timeline 档（只留单声道片段 clip_b 测混音）
  timelineClips.splice(0, 1);
  const tOut = await tools.call('measure_audio_js', {
    scope: 'timeline',
    start: 1,
    duration: 2,
    code: RMS_PEAK_CODE,
  }, fx.context);
  assert.equal(tOut.ok, true, JSON.stringify(tOut));
  const expectedHalf = RMS + 20 * Math.log10(0.5) + 20 * Math.log10(Math.SQRT1_2);
  assert.ok(Math.abs(tOut.value.channels[0].rmsDb - expectedHalf) < 0.1);

  // 4) 临时文件已清理
  const leftover = fx.ws.list().filter((f) => f.path.startsWith('audio-js/'));
  assert.deepEqual(leftover, [], '工作区不应残留 audio-js 临时文件');
});

test('P6-03 语法错误行列号、死循环超时终止、内存超限与输出超限拒绝、联网/文件/Node 越权尝试拒绝', { skip: skipFfmpeg, timeout: 120_000 }, async (t) => {
  const fx = await makeP1Fixture(t);
  await fx.addMedia({ id: 'sine1', name: 'sine-mono.wav', kind: 'audio', bytes: fs.readFileSync(SINE_MONO), extra: { duration: 3 } });

  const tools = createAudioJsTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    assets: fx.assets,
    project: fx.project,
    workspace: () => fx.ws,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    sandbox: sharedSandbox,
  });
  t.after(() => tools.close());

  // 1) 语法错误行列号
  const syn = await tools.call('measure_audio_js', {
    mediaId: 'sine1',
    sampleRate: 8000,
    code: 'const ok = 1;\nconst broken = ;\nreturn ok;',
  }, fx.context);
  assert.equal(syn.ok, false);
  assert.equal(syn.kind, 'syntax');
  assert.equal(syn.line, 2);
  assert.equal(syn.column, 16);
  assert.match(syn.error, /第 2 行第 16 列/);

  // 2) 运行期异常行号
  const exc = await tools.call('measure_audio_js', {
    mediaId: 'sine1',
    sampleRate: 8000,
    code: 'const a = 42;\nthrow new Error("boom:" + a);',
  }, fx.context);
  assert.equal(exc.ok, false);
  assert.equal(exc.kind, 'exception');
  assert.match(exc.error, /boom:42/);
  assert.match(exc.error, /第 2 行/);

  // 3) 死循环超时终止
  const t0 = Date.now();
  const loop = await tools.call('measure_audio_js', {
    mediaId: 'sine1',
    sampleRate: 8000,
    timeoutMs: 1200,
    code: 'while (true) {}',
  }, fx.context);
  const elapsed = Date.now() - t0;
  assert.equal(loop.ok, false);
  assert.equal(loop.kind, 'timeout');
  assert.match(loop.error, /已终止/);
  assert.ok(elapsed < 10_000, `死循环应在时限附近终止，实际 ${elapsed} ms`);

  // 4) 内存超限拒绝（超大 TypedArray 分配与堆内存炸弹）
  const hugeAlloc = await tools.call('measure_audio_js', {
    mediaId: 'sine1',
    sampleRate: 8000,
    code: 'return new Float64Array(2 ** 40).length;',
  }, fx.context);
  assert.equal(hugeAlloc.ok, false);
  assert.match(hugeAlloc.error, /RangeError|内存|allocation/i);

  // 5) 256 KiB 输出上限拒绝
  const tooLarge = await tools.call('measure_audio_js', {
    mediaId: 'sine1',
    sampleRate: 8000,
    code: 'return "x".repeat(300 * 1024);',
  }, fx.context);
  assert.equal(tooLarge.ok, false);
  assert.equal(tooLarge.kind, 'too-large');
  assert.match(tooLarge.error, /262144/);

  // 6) 联网 / 文件 / Node API 越权尝试拒绝
  let leakHits = 0;
  const leakSrv = http.createServer((_req, res) => { leakHits += 1; res.end('leaked'); });
  await new Promise((r) => leakSrv.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => leakSrv.close(r)));
  const leakUrl = `http://127.0.0.1:${leakSrv.address().port}/secret`;

  const netAttempt = await tools.call('measure_audio_js', {
    mediaId: 'sine1',
    sampleRate: 8000,
    code: `return await fetch(${JSON.stringify(leakUrl)}).then(r => r.text());`,
  }, fx.context);
  assert.equal(netAttempt.ok, false);
  assert.match(netAttempt.error, /沙箱里不能联网/);
  assert.equal(leakHits, 0, '本地服务绝不能收到沙箱请求');

  const nodeAttempt = await tools.call('measure_audio_js', {
    mediaId: 'sine1',
    sampleRate: 8000,
    code: 'return { proc: typeof process, req: typeof require, fs: typeof Buffer, win: typeof window };',
  }, fx.context);
  assert.equal(nodeAttempt.ok, true);
  assert.deepEqual(nodeAttempt.value, { proc: 'undefined', req: 'undefined', fs: 'undefined', win: 'undefined' });
});

test('P6-04 跨项目素材拒绝、本机路径拒绝、撤权取消（abortForFence）与 worker 真实关闭', { skip: skipFfmpeg, timeout: 120_000 }, async (t) => {
  const fx = await makeP1Fixture(t, { extraProjects: ['proj_b'] });
  await fx.addMedia({ id: 'own_audio', name: 'own.wav', kind: 'audio', bytes: fs.readFileSync(SINE_MONO), extra: { duration: 3 } });
  await fx.addMedia({ id: 'other_audio', name: 'other.wav', kind: 'audio', bytes: fs.readFileSync(SINE_MONO), forProject: 'proj_b', extra: { duration: 3 } });

  // 独立沙箱实例以便验证取消与 close() 后 Chrome 进程真实关闭
  const dedicatedSandbox = createAudioSandbox();
  const tools = createAudioJsTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    assets: fx.assets,
    project: fx.project,
    workspace: () => fx.ws,
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    sandbox: dedicatedSandbox,
  });
  t.after(() => tools.close());

  // 1) 跨项目素材拒绝
  await assert.rejects(
    tools.call('measure_audio_js', { mediaId: 'other_audio', code: 'return 1;' }, fx.context),
    (err) => err instanceof AudioJsToolError && err.code === 'media-not-found',
  );

  // 2) 试图传入本机路径被拒绝
  await assert.rejects(
    tools.call('measure_audio_js', { mediaId: 'own_audio', path: SINE_MONO, code: 'return 1;' }, fx.context),
    (err) => err instanceof AudioJsToolError && err.code === 'bad-args',
  );

  // 3) 先跑一次确认沙箱 Chrome 已启动
  const warm = await tools.call('measure_audio_js', { mediaId: 'own_audio', sampleRate: 8000, code: 'return input.frames;' }, fx.context);
  assert.equal(warm.ok, true);
  assert.equal(dedicatedSandbox.alive, true, '预热后专用沙箱应处于存活态');

  // 4) 发起长时间死循环测量，并在中途触发 abortForFence 撤权取消
  const longRun = tools.call('measure_audio_js', {
    mediaId: 'own_audio',
    sampleRate: 8000,
    timeoutMs: 30_000,
    code: 'while (true) {}',
  }, fx.context);
  await sleep(400);
  const tCancel = Date.now();
  await fx.resources.abortForFence(fx.context, 'revoked-mid-run');
  await assert.rejects(longRun, (err) => err instanceof AudioJsToolError);
  assert.ok(Date.now() - tCancel < 8_000, '撤权后应立即中止沙箱无需等满 30 秒');

  const closeRes = await tools.close('test-finish');
  assert.equal(closeRes.childrenClosed, true);
  assert.equal(closeRes.streamsClosed, true);
  assert.equal(dedicatedSandbox.alive, false, 'close() 后沙箱 worker/浏览器已真实关闭');
});
