/**
 * 云端 Agent 看画面：托管渲染服务没出图时，模型拿到的是它的原话，不是笼统的「没有可用的出图节点」。
 *
 * 0.7.18 验收（2026-10-19 18:16 UTC，项目「验收018-Claude」）：项目没开托管方的渲染节点，渲染服务回 403 `service-disabled`，
 * 出图分级（`frame-dispatcher.mjs`）把这句话吞了，模型只看到「没有可用的出图节点（成员设备离线或不合格，云端渲染服务不可用）」。
 *
 * SF-REASON-01 真实的看画面客户端 + 出图分级：登记 202、问到 403 `service-disabled` → 抛出的就是渲染服务那句话，带 `look`
 * SF-REASON-02 渲染超时：错误码 `render-timeout` 与调试信息原样带出
 * SF-REASON-03 工作进程自己的回答（`ok: false`，比如片段不存在）原样交回，由工具照桌面版的办法处理
 * SF-REASON-04 托管渲染没出图、手机浏览器兜住了：仍用手机浏览器的帧
 * SF-REASON-05 没有托管渲染、也没有成员设备：照旧回「没有可用的出图节点」
 * SF-REASON-06 云端失败、手机浏览器那一趟时这一轮被停：抛停止的原因，不抛渲染服务那句
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { dispatchFrameSnapshot, FRAME_SOURCE_LEVELS } from '../agent/service/frame-dispatcher.mjs';
import { createLookClient } from '../agent-service/look-client.mjs';
import { LOOK_ERRORS } from '../hosted-render/look.mjs';
import { generateServiceKeyPair, newInstanceId } from '../auth/service-identity.mjs';

const P = `sp_${'x'.repeat(26)}`;
const GENERIC = /没有可用的出图节点/;

function client(script) {
  const pair = generateServiceKeyPair();
  const key = { service: 'agent', kid: pair.kid, priv: pair.priv, pub: pair.pub, instanceId: newInstanceId(), instanceName: 'agent-test' };
  const logs = [];
  const c = createLookClient({
    url: 'http://127.0.0.1:5399', key, limits: { backoffMs: [5], reconnectMs: 400 }, log: (event, f) => logs.push({ event, ...f }),
    fetch: async () => {
      const next = script.shift();
      if (!next) throw new Error('script exhausted');
      return { status: next.status, json: async () => next.json };
    },
  });
  return { post: c.forProject(P, { cards: () => ({}) }), logs };
}

const request = { path: '/api/vision/snapshot', body: { project: { tracks: [] }, t: 2.5 } };

test('SF-REASON-01 项目没开渲染节点：模型拿到渲染服务那句 service-disabled，不是笼统的「没有可用的出图节点」', async () => {
  const { post, logs } = client([
    { status: 202, json: { ok: true, state: 'queued', queuePosition: 0 } },
    { status: 403, json: { ok: false, look: 'service-disabled', error: LOOK_ERRORS['service-disabled'] } },
  ]);
  const dispatchLogs = [];
  const err = await dispatchFrameSnapshot({
    memberNodes: [],
    cloudLook: () => post(request.path, request.body),
    request,
    log: (event, f) => dispatchLogs.push({ event, ...f }),
  }).then(() => null, (e) => e);
  assert.ok(err, '应当失败');
  assert.equal(err.message, LOOK_ERRORS['service-disabled']);
  assert.doesNotMatch(err.message, GENERIC);
  assert.equal(err.look, 'service-disabled');
  assert.ok(logs.some((l) => l.event === 'agent.look.refused' && l.look === 'service-disabled' && l.status === 403), '客户端照旧记 refused');
  assert.ok(dispatchLogs.some((l) => l.event === 'frame.cloud-failed' && l.look === 'service-disabled'), '分级记下云端失败的原因码');
});

test('SF-REASON-02 渲染超时：错误码 render-timeout 与调试信息原样带出', async () => {
  const debug = { reason: 'render-timeout', stalledStep: 'render-frame', cards: {} };
  const { post } = client([
    { status: 202, json: { ok: true, state: 'running', queuePosition: 0 } },
    { status: 504, json: { ok: false, look: 'timeout', error: LOOK_ERRORS.timeout, debug } },
  ]);
  const err = await dispatchFrameSnapshot({ cloudLook: () => post(request.path, request.body), request }).then(() => null, (e) => e);
  assert.ok(err);
  assert.equal(err.message, LOOK_ERRORS.timeout);
  assert.equal(err.code, 'render-timeout');
  assert.deepEqual(err.debug, debug);
});

test('SF-REASON-03 工作进程自己的回答（ok: false）原样交回', async () => {
  const answer = { ok: false, error: '片段 c-404 不存在' };
  const res = await dispatchFrameSnapshot({ cloudLook: async () => answer, request });
  assert.equal(res.ok, false);
  assert.equal(res.error, answer.error);
  assert.equal(res.source, FRAME_SOURCE_LEVELS.HOSTED_RENDER);
});

test('SF-REASON-04 托管渲染没出图、手机浏览器兜住了：用手机浏览器的帧', async () => {
  const mobile = { id: 'm1', isMobile: true, online: true, authorized: true, capabilities: { canSnapshot: true }, keepPlayhead: true };
  const res = await dispatchFrameSnapshot({
    memberNodes: [mobile],
    cloudLook: async () => { throw Object.assign(new Error(LOOK_ERRORS['service-disabled']), { look: 'service-disabled' }); },
    callLocal: async () => ({ ok: true, frame: 'mobile' }),
    request,
  });
  assert.equal(res.source, FRAME_SOURCE_LEVELS.BROWSER_MOBILE);
  assert.equal(res.frame, 'mobile');
});

test('SF-REASON-05 没有托管渲染、也没有成员设备：照旧回「没有可用的出图节点」', async () => {
  await assert.rejects(dispatchFrameSnapshot({ cloudLook: null, request }), GENERIC);
});

test('SF-REASON-06 云端失败、手机浏览器那一趟时这一轮被停：抛停止的原因', async () => {
  const ac = new AbortController();
  const mobile = (id) => ({ id, isMobile: true, online: true, authorized: true, capabilities: { canSnapshot: true }, keepPlayhead: true });
  const err = await dispatchFrameSnapshot({
    memberNodes: [mobile('m1'), mobile('m2')],
    cloudLook: async () => { throw Object.assign(new Error(LOOK_ERRORS['service-disabled']), { look: 'service-disabled' }); },
    // 手机浏览器那一趟没出图，同时这一轮被停
    callLocal: async () => { ac.abort(new Error('run-fenced')); return { ok: false }; },
    request,
    signal: ac.signal,
  }).then(() => null, (e) => e);
  assert.equal(err?.message, 'run-fenced');
});
