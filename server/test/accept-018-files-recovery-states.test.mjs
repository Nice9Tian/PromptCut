/**
 * 0.7.18 逐项验收「非过期与坏文件」(2.1-9)的输入矩阵:超时、错误节点、未登录、密码错、旧凭证、被踢。
 * 预期原文:「暂时离线 / 认证 / 权限分别提示,不转本地」。
 *
 * 用真的恢复协调器 `server/recovery/coordinator.mjs`(打开带协作关联的旧文件后跑的就是它),把每种失败喂进去,看它落在哪个状态:
 *   waiting-host(暂时离线,自动重试)、needs-auth(要认证)、rejected(被拒/没权限)、deleted(房间已删/取消协作)。
 * 界面上每个状态对应的提示文字在 `src/editor/sync/SyncChips.tsx`,这里只验状态归类(文字是一级语义,不在这里定)。
 * 「转本地」本身 main 上没有(见地图 2.1-8),所以「不转本地」在 main 上靠「没有任何转换入口」成立(grep 为证,写在地图里)。
 *
 * 带 `todo` 的两条是 main 上目前不成立的归类(产品问题,见地图「产品问题」5):
 * 错误节点上的「没有此房间」和本机凭证被撤销,协调器都直接报 deleted(即「房间已删除」),而任务书要求它们既不当作已过期、也不触发转换。
 * 分支 claude/v18-missing 的 9de16f81 改了这两处;合入后这两条应转绿,届时去掉 todo。
 *
 * 跑:npm test -- server/test/accept-018-files-recovery-states.test.mjs
 * 合入前演练:先 `git show claude/v18-missing:server/recovery/coordinator.mjs > <临时>/coordinator.mjs`,再设 ACC018_COORDINATOR_FILE 指过去跑同一个文件。
 */
import { srcUrl } from '../../src/testing/registerTs.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// ACC018_COORDINATOR_FILE:合入前演练用,指向别处的 coordinator.mjs(例如从分支 git show 出来的副本);不设就是仓库里的这份
const { RecoveryCoordinator } = await import(process.env.ACC018_COORDINATOR_FILE ? pathToFileURL(process.env.ACC018_COORDINATOR_FILE).href : '../recovery/coordinator.mjs');

const DESCRIPTOR = { version: 1, roomId: 'sp_abcdefghijklmnopqrstuvwxyz', service: 'https://old-test-node.invalid', where: 'hosted' };
const reason = (reason, extra = {}) => Object.assign(new Error(reason), { reason, ...extra });
const SAVED = { selected: { candidate: { where: 'hosted' }, as: 'member', username: 'zoe', key: 'device-vault' }, host: false, identities: [{}] };

/** 跑一次恢复,收集到第一个终态/等待态为止,然后取消(不让重试计时器挂着) */
async function run(hooks) {
  const states = []; const called = { enter: 0, discover: 0, identity: 0, host: 0 };
  const c = new RecoveryCoordinator({
    state: (k, d) => states.push(k),
    identity: async (...a) => { called.identity++; return hooks.identity ? hooks.identity(...a) : SAVED; },
    host: async () => { called.host++; return {}; },
    // gone:分支 claude/v18-missing 的协调器会先问文档服务「有没有已不存在的证明」;这里一律答「没有墓碑」。main 的协调器没有这个钩子,忽略它
    gone: async () => ({ state: 'no-tombstone' }),
    discover: async (...a) => { called.discover++; if (hooks.discover) return hooks.discover(...a); return { where: 'hosted' }; },
    enter: async (...a) => { called.enter++; return hooks.enter ? hooks.enter(...a) : { ok: true }; },
  });
  c.start(DESCRIPTOR, 'content-1');
  await new Promise(r => setTimeout(r, 60));
  c.cancel();
  return { states, called };
}

test('ACC018-STATE-1 超时 / 服务故障 / 网络不通:等待并自动重试(暂时离线),不报已删除、不报要认证', async () => {
  for (const [label, hooks] of [
    ['discover 超时', { discover: async () => { throw Object.assign(new Error('ETIMEDOUT'), { code: 'ETIMEDOUT' }); } }],
    ['enter 返回 unreachable', { enter: async () => ({ ok: false, error: 'unreachable' }) }],
    ['enter 返回 503 类', { enter: async () => ({ ok: false, error: 'unavailable' }) }],
  ]) {
    const { states } = await run(hooks);
    assert.deepEqual(states.slice(0, 2), ['recovering', 'waiting-host'], label);
    assert.ok(!states.includes('deleted') && !states.includes('needs-auth') && !states.includes('rejected'), `${label}:${states}`);
  }
});

test('ACC018-STATE-2 未登录 / 密码错 / 认证被拒:要认证(needs-auth),不重试,不报已删除', async () => {
  for (const e of ['auth', 'unauthorized']) {
    const { states, called } = await run({ enter: async () => ({ ok: false, error: e }) });
    assert.deepEqual(states, ['recovering', 'needs-auth'], e);
    assert.equal(called.enter, 1, '终止性错误不重试');
  }
  const none = await run({ identity: async () => ({ identities: [], selected: null }) });
  assert.deepEqual(none.states, ['recovering', 'needs-auth'], '本机没有任何身份记录:要认证一次');
});

test('ACC018-STATE-3 被踢 / 禁入 / 移出名单:被拒(rejected,权限类提示),不重试,不报已删除', async () => {
  for (const e of ['kicked', 'banned', 'removed']) {
    const { states, called } = await run({ enter: async () => ({ ok: false, error: e }) });
    assert.deepEqual(states, ['recovering', 'rejected'], e);
    assert.equal(called.enter, 1);
  }
});

test('ACC018-STATE-4 错误节点上的「没有此房间」(HTTP 404 / no-project):不能当作房间已删除', { todo: '产品问题:coordinator.mjs 第 51 行把 no-project 直接归为 deleted;任务书要求错误节点的 404 既不当过期也不触发转换。分支 claude/v18-missing 的 9de16f81 已改' }, async () => {
  const { states } = await run({ discover: async () => { throw reason('no-project'); } });
  assert.ok(!states.includes('deleted'), `错误节点的 404 被报成 ${states}`);
});

test('ACC018-STATE-5 本机凭证被撤销(旧凭证):要认证,不能当作房间已删除', { todo: '产品问题:coordinator.mjs 第 21 行 saved.revoked 直接报 deleted;「旧凭证」应走认证提示。分支 claude/v18-missing 的 9de16f81 已改' }, async () => {
  const { states } = await run({ identity: async () => ({ revoked: true }) });
  assert.ok(!states.includes('deleted'), `本机凭证被撤销被报成 ${states}`);
});

test('ACC018-STATE-6 账号项目(云端)进入失败的提示分三类:暂时离线 / 要重新登录 / 没权限,三句不同,且都不说「项目已不存在」', async () => {
  const { accountErrorText } = await import(srcUrl('account/client.ts'));
  const offline = [accountErrorText(503, 'session-unavailable'), accountErrorText(503, 'asset-unavailable'), accountErrorText(0, 'network'), accountErrorText(503, 'whatever')];
  const auth = [accountErrorText(401, 'credential-revoked'), accountErrorText(401, 'login-required'), accountErrorText(401, 'bad-login'), accountErrorText(401, 'whatever')];
  const permission = [accountErrorText(403, 'banned'), accountErrorText(403, 'not-listed'), accountErrorText(403, 'whatever')];
  const gone = accountErrorText(404, 'project-gone');
  const all = [...offline, ...auth, ...permission];
  for (const t of all) assert.ok(!t.includes('已不存在'), `非「已不存在」的失败不能说项目不存在:${t}`);
  assert.match(gone, /已不存在/, '只有明确的 project-gone 才说已不存在');
  // 三类互不相同
  const kinds = [new Set(offline), new Set(auth), new Set(permission)];
  for (let i = 0; i < 3; i++) for (let j = i + 1; j < 3; j++) for (const a of kinds[i]) assert.ok(!kinds[j].has(a), `两类提示不能共用一句:${a}`);
  assert.ok(offline.every(t => /暂时|稍后|网络/.test(t)), '离线类提示是「暂时」类');
  assert.ok(auth.every(t => /登录|账号/.test(t)), '认证类提示指向登录');
  assert.ok(permission.every(t => /权限|禁止|名单/.test(t)), '权限类提示指向权限');
});
