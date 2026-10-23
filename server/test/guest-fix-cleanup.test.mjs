/**
 * 三天清理真的回收素材字节、清掉的项目号不再发给别人（claude/guest-fix，审查 REVIEW-guest-identity 的 C / S1）。
 *
 * 审查实测（PROBE-4）：游客 A 的项目三天清理后，游客 B 带同一个 `projectId` 新建成功、拿到读写并成为创建者，
 * 同一处素材库里 A 的字节还在。改法：
 * - `server/account/authority.mjs` 的 `createProject`：删掉过的项目号也回 409 `project-id-taken`；
 * - `server/asset-store/project-reaper.mjs`：素材服务收到删除事件就删整个项目（`removeProject`），起服务时补删。
 * 端到端（真的文档服务 + 素材子进程）的那一条在 `asset-wiring-integration.test.mjs` 末尾。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto, { randomBytes } from 'node:crypto';
import { openAccountLedger } from '../account/ledger.mjs';
import { createAccountAuthority } from '../account/authority.mjs';
import { GUEST_LIMITS, signGuestToken } from '../account/guest.mjs';
import { createProjectAssetStores } from '../asset-store/project-stores.mjs';
import { createProjectReaper } from '../asset-store/project-reaper.mjs';

const guestKey = randomBytes(32);
const sha = buf => crypto.createHash('sha256').update(buf).digest('hex');

async function openAuthority(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-cleanup-'));
  const ledger = openAccountLedger({ file: path.join(dir, 'doc.sqlite'), authorityId: 'cleanup-doc' });
  const authority = createAccountAuthority({ ledger, pollMs: 0, guestKey,
    accountClient: { async verify() { throw Object.assign(new Error('no'), { status: 401, code: 'unauthorized' }); }, async events() { return { events: [], headSeq: 0 }; } },
    initializeProject: async () => ({ contentId: 'c' }) });
  await authority.start();
  t.after(() => { authority.close(); ledger.close(); fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); });
  return { authority, ledger, dir };
}

test('清掉的项目号不许别人重建：游客 B 带 A 那个已清理的项目号新建回 409 project-id-taken（改前建成、成了创建者）', async t => {
  const { authority, ledger } = await openAuthority(t);
  const a = signGuestToken({ key: guestKey, at: Date.now() });
  const b = signGuestToken({ key: guestKey, at: Date.now() });
  const made = await authority.createProject({ accessToken: a.token }, { name: 'A 的项目', requestId: 'ra' });
  ledger.transaction(state => { state.projects[made.projectId].createdAt = Date.now() - GUEST_LIMITS.ttlMs - 1000; });
  assert.deepEqual(authority.sweepExpiredGuestProjects(), [made.projectId]);
  const err = await authority.createProject({ accessToken: b.token }, { name: 'B 的项目', requestId: 'rb', projectId: made.projectId }).then(() => null, e => ({ status: e.status, code: e.code }));
  console.log('C reuse', JSON.stringify(err));
  assert.deepEqual(err, { status: 409, code: 'project-id-taken' });
  const read = await authority.authorizePrincipal({ accessToken: b.token }, { projectId: made.projectId, action: 'read' }).then(r => r.access, e => e.code);
  assert.notEqual(read, 'rw');
  // 不带项目号新建照常（云端发新号），B 的那一个项目名额没被这次 409 占掉
  const fresh = await authority.createProject({ accessToken: b.token }, { name: 'B 的项目', requestId: 'rb2' });
  assert.notEqual(fresh.projectId, made.projectId);
  // 原创建者重用自己删掉的项目号仍然放行（「放弃这次搬迁」后再搬，还是原来的项目号）
  const again = await authority.createProject({ accessToken: a.token }, { name: 'A 的项目又一次', requestId: 'ra2', projectId: made.projectId });
  assert.equal(again.projectId, made.projectId);
});

test('素材服务收到删除事件：整个项目的字节删掉、待删清单落盘、别的项目不动；别的事件不碰', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-guest-reaper-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const stores = createProjectAssetStores({ dir: path.join(dir, 'assets') });
  const put = async (pid, text) => {
    const bytes = Buffer.from(text + crypto.randomUUID());
    const hash = sha(bytes);
    const s = stores.project(pid).stores.media;
    await s.putChunk(hash, 0, { size: bytes.length, ext: 'mp4' }, [bytes]);
    assert.equal((await s.complete(hash)).status, 'ok');
    return hash;
  };
  const hA = await put('p-a', 'guest A private video ');
  const hB = await put('p-b', 'other project ');
  const dirA = stores.project('p-a').dir;
  const file = path.join(dir, 'project-reaper.json');
  const logs = [];
  const reaper = createProjectReaper({ projectStores: stores, file, log: (e, f) => logs.push([e, f]) });
  t.after(() => reaper.close());
  await reaper.start();
  // 别的事件：不碰
  for (const event of [{ type: 'project-access-changed', reason: 'kick', projectId: 'p-a' }, { type: 'credentials-revoked', accountId: 'acc_x' }]) {
    assert.deepEqual(await reaper.handleAccessEvent(event), { complete: true, closedStreams: [], stoppedRuns: [], rejectedCredentials: [] });
  }
  await reaper.idle();
  assert.ok(fs.existsSync(dirA));
  // 删除事件：回执立刻给，字节在后台删掉
  const receipt = await reaper.handleAccessEvent({ type: 'project-access-changed', reason: 'delete', projectId: 'p-a', accountIds: [] });
  assert.equal(receipt.complete, true);
  await reaper.idle();
  console.log('C reaped', JSON.stringify({ dirAExists: fs.existsSync(dirA), pending: reaper.pending(), logs: logs.map(l => l[0]) }));
  assert.equal(fs.existsSync(dirA), false, 'A 的整个项目目录删掉了');
  assert.deepEqual(reaper.pending(), []);
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')).pending, []);
  // 换一个进程（新的素材库对象）看同一处目录：A 的字节不在了，B 的还在
  const stores2 = createProjectAssetStores({ dir: path.join(dir, 'assets') });
  assert.equal(await stores2.project('p-a').stores.media.stat(hA), null);
  assert.ok(await stores2.project('p-b').stores.media.stat(hB));
  // 同一个进程里，删干净之后这个项目号能再建一个空库（原创建者重用，文档服务放行的那一种）
  assert.equal(await stores.project('p-a').stores.media.stat(hA), null);
  // 同一条删除事件重放（确认丢了、重启后重发）：幂等
  await reaper.handleAccessEvent({ type: 'project-access-changed', reason: 'delete', projectId: 'p-a', accountIds: [] });
  await reaper.idle();
  assert.deepEqual(reaper.pending(), []);
});

test('删不成就退避重试；进程在删完之前重启，起来接着删', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pc-guest-reaper-retry-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const file = path.join(dir, 'project-reaper.json');
  let fail = 2;
  const removed = [];
  const flaky = { async removeProject(id, opts) { if (fail-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' }); removed.push([id, opts]); } };
  // 回执之前当场试两次都失败、转后台，后台第一次就删成
  const reaper = createProjectReaper({ projectStores: flaky, file, retryMs: [5, 5], inlineRetryMs: [0, 1] });
  t.after(() => reaper.close());
  const receipt = await reaper.handleAccessEvent({ type: 'project-access-changed', reason: 'delete', projectId: 'p-x' });
  assert.equal(receipt.complete, true, '删不成也照样回执，不卡住事件确认');
  assert.deepEqual(removed, []);
  for (let i = 0; i < 200 && !removed.length; i++) await new Promise(r => setTimeout(r, 5));
  assert.deepEqual(removed, [['p-x', { recreatable: true }]], '失败两次之后在后台删成了');
  // 当场删成的：回执的时候已经删完
  const order = [];
  const inline = createProjectReaper({ projectStores: { async removeProject(id) { order.push(`removed ${id}`); } }, file });
  t.after(() => inline.close());
  await inline.handleAccessEvent({ type: 'project-access-changed', reason: 'delete', projectId: 'p-z' }).then(() => order.push('receipt'));
  assert.deepEqual(order, ['removed p-z', 'receipt']);
  // 记进清单之后、删完之前进程没了：清单在盘上，新进程起来接着删
  const stuck = createProjectReaper({ projectStores: { removeProject: () => new Promise(() => {}) }, file });
  void stuck.handleAccessEvent({ type: 'project-access-changed', reason: 'delete', projectId: 'p-y' });
  for (let i = 0; i < 200; i++) { await new Promise(r => setTimeout(r, 5)); try { if (JSON.parse(await fsp.readFile(file, 'utf8')).pending.includes('p-y')) break; } catch { /* 还没写 */ } }
  stuck.close();
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')).pending, ['p-y']);
  const done = [];
  const next = createProjectReaper({ projectStores: { async removeProject(id) { done.push(id); } }, file });
  t.after(() => next.close());
  await next.start();
  assert.deepEqual(done, ['p-y'], '起服务时先删完');
  assert.deepEqual(JSON.parse(await fsp.readFile(file, 'utf8')).pending, []);
});
