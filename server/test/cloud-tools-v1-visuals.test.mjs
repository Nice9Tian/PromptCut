/**
 * V1 用户可视记录提供者与受权路由单测：
 *   - `server/agent/service/hosted-visuals.mjs`
 *   - `server/agent-service/visual-routes.mjs`
 *   - `src/editor/right/ToolVisual.tsx`
 *
 * 覆盖：
 *   1. 模型调用 `get_gif` 生成持久化记录 `visuals/<visualId>.json`（含 `visualId/kind/spec/sourceRev/projectId/conversationId/aclRevision/frames/gifAssetRef/createdAt`）；
 *   2. `shared` 对话下 owner 与同项目其他有效成员读取记录与动图文件（`Cache-Control: private, no-store`，剥离 `gifAssetRef`）；
 *   3. `private` 对话下 owner 可读、项目创建者只读例外可读（`creatorReadOnly: true`）、非 owner 普通成员被 403 拒绝；
 *   4. 共有切私有后 `aclRevision` 递增：旧 `?aclRevision=` 地址立即失效（409/403），普通成员立即 403，且不能凭文件名或 asset hash 绕过 ACL；
 *   5. 被踢、退出登录、跨对话、跨项目一律 401/403/404 拒绝；
 *   6. 服务重启后从磁盘持久保留并可正常读取；
 *   7. `ToolVisual.tsx` 云端对话模式下按受权端点加载，切私有被撤权时立即清空缓存不残留。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createServer } from 'vite';
import { makeP1Fixture } from './cloud-tools-p1-fixture.mjs';
import {
  conversationVisualsDir,
  createVisualsTools,
  VISUALS_TOOL_NAMES,
} from '../agent/service/hosted-visuals.mjs';
import { createVisualRoutes, matchVisualRoute } from '../agent-service/visual-routes.mjs';

function sampleProjectWithCard() {
  return {
    id: 'proj_test',
    width: 1920,
    height: 1080,
    fps: 30,
    duration: 6,
    tracks: [
      {
        id: 't_cards',
        name: '卡片轨',
        clips: [
          {
            id: 'clip_card_1',
            cardId: 'title-card',
            label: '开场标题',
            start: 1,
            end: 5,
            params: { title: 'Hello Cloud Visuals', position: 'left' },
          },
        ],
      },
    ],
    media: [],
  };
}

test('V1-01 路由匹配器与模型 get_gif 生成持久可视记录 visuals/<visualId>.json', async (t) => {
  assert.deepEqual([...VISUALS_TOOL_NAMES], ['get_gif']);
  assert.deepEqual(matchVisualRoute('/agent/v1/conversations/conv_1/visuals/v-abcdef123456'), {
    kind: 'record',
    conversationId: 'conv_1',
    visualId: 'v-abcdef123456',
  });
  assert.deepEqual(
    matchVisualRoute('/agent/v1/conversations/conv_1/visuals/v-abcdef123456/files/0123456789abcdef0123.gif'),
    {
      kind: 'file',
      conversationId: 'conv_1',
      visualId: 'v-abcdef123456',
      fileName: '0123456789abcdef0123.gif',
    },
  );
  assert.equal(matchVisualRoute('/agent/v1/conversations/conv_1/visuals/../../etc/passwd'), null);

  const fx = await makeP1Fixture(t);
  const dataDir = path.join(fx.dir, 'agent-data');
  const gifBytes = Buffer.from('GIF89a-test-animated-gif-payload');
  const gridBytes = Buffer.from('PNG-test-4x2-grid-payload');

  const visuals = createVisualsTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    dataDir,
    workspace: () => fx.ws,
    project: {
      async snapshot() {
        return { project: sampleProjectWithCard(), rev: 7 };
      },
    },
    aclRevisionOf: async () => 3,
    renderGif: async (_ctx, { clipId, times }) => {
      assert.equal(clipId, 'clip_card_1');
      assert.equal(times.length, 8);
      return { gif: gifBytes, grid: gridBytes };
    },
  });
  t.after(() => visuals.close());

  const out = await visuals.call('get_gif', { clipId: 'clip_card_1' }, fx.context);
  assert.equal(out.ok, true);
  assert.ok(out.visualId.startsWith('v-'));
  assert.equal(out.sourceRev, 7);
  assert.equal(out.aclRevision, 3);
  assert.equal(out.times.length, 8);
  assert.equal(out.__image.mime, 'image/png');
  assert.equal(Buffer.from(out.__image.base64, 'base64').equals(gridBytes), true);

  // 验证磁盘对话目录 visuals/<visualId>.json 已持久化且字段完整
  const visualsDir = conversationVisualsDir(dataDir, fx.context.projectId, fx.context.conversationId);
  const diskFile = path.join(visualsDir, `${out.visualId}.json`);
  assert.equal(fs.existsSync(diskFile), true, 'visuals/<visualId>.json 应已落盘');
  const diskRecord = JSON.parse(fs.readFileSync(diskFile, 'utf8'));
  assert.equal(diskRecord.visualId, out.visualId);
  assert.equal(diskRecord.kind, 'gif');
  assert.equal(diskRecord.projectId, fx.context.projectId);
  assert.equal(diskRecord.conversationId, fx.context.conversationId);
  assert.equal(diskRecord.sourceRev, 7);
  assert.equal(diskRecord.aclRevision, 3);
  assert.ok(diskRecord.spec && diskRecord.spec.clipId === 'clip_card_1');
  assert.equal(diskRecord.frames.length, 8);
  assert.ok(diskRecord.gifAssetRef && typeof diskRecord.gifAssetRef.hash === 'string');
  assert.ok(typeof diskRecord.createdAt === 'string');

  // 工作区镜像也存在
  assert.equal(fx.ws.exists(`visuals/${out.visualId}.json`), true);
});

test('V1-02 受权访问全矩阵：同对话成员读取、创建者只读 private、非 owner 读 private 被拒、共有切私有立即失效、跨对话/跨项目被拒、重启后持久保留', async (t) => {
  const fx = await makeP1Fixture(t);
  const dataDir = path.join(fx.dir, 'agent-data');
  const projA = fx.context.projectId;
  const conv1 = fx.context.conversationId;
  const conv2 = 'conv_second_999';
  const projB = 'sp_otherproject22222222222222';

  let conv1Visibility = 'shared';
  let conv1AclRev = 1;
  const kickedAccounts = new Set();

  const gifBytes = Buffer.from('GIF89a-private-protected-bytes-888');
  const gridBytes = Buffer.from('PNG-private-protected-grid-888');

  let visuals = createVisualsTools({
    contextAccess: fx.resources.contextAccess,
    resources: fx.resources,
    dataDir,
    workspace: () => fx.ws,
    project: {
      async snapshot() {
        return { project: sampleProjectWithCard(), rev: 12 };
      },
    },
    aclRevisionOf: async () => conv1AclRev,
    renderGif: async () => ({ gif: gifBytes, grid: gridBytes }),
  });

  const generated = await visuals.call('get_gif', { clipId: 'clip_card_1' }, fx.context);
  const vid = generated.visualId;

  // 构造模拟票据表：owner（acct_owner）、普通成员（acct_member）、项目创建者（acct_creator）、另一项目成员（acct_proj_b）
  const tickets = new Map([
    ['tk-owner', { projectId: projA, accountId: 'acct_owner', creator: false }],
    ['tk-member', { projectId: projA, accountId: 'acct_member', creator: false }],
    ['tk-creator', { projectId: projA, accountId: 'acct_creator', creator: true }],
    ['tk-proj-b', { projectId: projB, accountId: 'acct_owner', creator: true }],
  ]);

  const makeRoutes = () => createVisualRoutes({
    dataDir,
    authenticate(req) {
      const m = /^Bearer\s+(\S+)$/.exec(req.headers.authorization || '');
      if (!m) return null;
      const principal = tickets.get(m[1]);
      if (!principal) return null;
      if (kickedAccounts.has(principal.accountId)) {
        throw Object.assign(new Error('member-kicked'), { status: 403, code: 'forbidden' });
      }
      return principal;
    },
    async authorizeConversation(identity, conversationId, action) {
      assert.equal(action, 'read');
      if (identity.projectId !== projA) {
        return { allowed: false, status: 404, code: 'no-conversation' };
      }
      if (conversationId !== conv1 && conversationId !== conv2) {
        return { allowed: false, status: 404, code: 'no-conversation' };
      }
      if (conversationId === conv2) {
        return {
          allowed: true,
          projectId: projA,
          visibility: 'shared',
          aclRevision: 1,
          ownerAccountId: 'acct_member',
        };
      }
      // conv1
      if (conv1Visibility === 'private') {
        const isOwner = identity.accountId === 'acct_owner';
        const isCreator = identity.creator === true;
        if (!isOwner && !isCreator) {
          return { allowed: false, status: 403, code: 'forbidden' };
        }
        return {
          allowed: true,
          projectId: projA,
          visibility: 'private',
          aclRevision: conv1AclRev,
          ownerAccountId: 'acct_owner',
          creatorReadOnly: isCreator && !isOwner,
        };
      }
      return {
        allowed: true,
        projectId: projA,
        visibility: 'shared',
        aclRevision: conv1AclRev,
        ownerAccountId: 'acct_owner',
        creatorReadOnly: false,
      };
    },
  });

  let routes = makeRoutes();
  const server = http.createServer((req, res) => {
    void routes(req, res).then((handled) => {
      if (!handled) {
        res.statusCode = 404;
        res.end();
      }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise((r) => server.close(r)));
  const base = `http://127.0.0.1:${server.address().port}`;

  // 1) shared 对话：owner 与普通成员均可读取记录与动图文件
  for (const token of ['tk-owner', 'tk-member']) {
    const r = await fetch(`${base}/agent/v1/conversations/${conv1}/visuals/${vid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(r.status, 200, `token ${token} 应能读 shared 记录`);
    assert.equal(r.headers.get('cache-control'), 'private, no-store');
    assert.equal(r.headers.get('x-pc-acl-revision'), '1');
    const body = await r.json();
    assert.equal(body.ok, true);
    assert.equal(body.aclRevision, 1);
    assert.equal(body.record.gifAssetRef, undefined, '对外记录绝不暴露内部 gifAssetRef');
    assert.ok(body.record.after?.gif.includes('aclRevision=1'));

    const gifRes = await fetch(`${base}${body.record.after.gif}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(gifRes.status, 200);
    assert.equal(gifRes.headers.get('cache-control'), 'private, no-store');
    const fetchedBytes = Buffer.from(await gifRes.arrayBuffer());
    assert.equal(fetchedBytes.equals(gifBytes), true);
  }

  const sharedGifPath = `/agent/v1/conversations/${conv1}/visuals/${vid}/files/${generated.gif.split('?')[0].split('/').pop()}`;

  // 2) 共有切私有（shared -> private，aclRevision 1 -> 2）
  conv1Visibility = 'private';
  conv1AclRev = 2;

  // 2a) 非 owner 普通成员立即不可读（记录与已知文件地址均 403）
  const memberRec = await fetch(`${base}/agent/v1/conversations/${conv1}/visuals/${vid}`, {
    headers: { Authorization: 'Bearer tk-member' },
  });
  assert.equal(memberRec.status, 403, '切私有后普通成员读记录立即 403');

  const memberFile = await fetch(`${base}${sharedGifPath}`, {
    headers: { Authorization: 'Bearer tk-member' },
  });
  assert.equal(memberFile.status, 403, '切私有后普通成员凭已知文件地址直取也立即 403');

  // 2b) 即使 owner 拿着旧的 ?aclRevision=1 地址请求，也因 aclRevision 过期被拒（409）
  const staleAclReq = await fetch(`${base}${sharedGifPath}?aclRevision=1`, {
    headers: { Authorization: 'Bearer tk-owner' },
  });
  assert.equal(staleAclReq.status, 409, '旧 aclRevision 缓存地址立即失效');

  // 2c) owner 用最新 aclRevision=2 正常读取
  const ownerPriv = await fetch(`${base}/agent/v1/conversations/${conv1}/visuals/${vid}`, {
    headers: { Authorization: 'Bearer tk-owner' },
  });
  assert.equal(ownerPriv.status, 200);
  const ownerPrivBody = await ownerPriv.json();
  assert.equal(ownerPrivBody.aclRevision, 2);
  assert.equal(ownerPrivBody.visibility, 'private');
  assert.equal(ownerPrivBody.creatorReadOnly, false);

  // 2d) 项目创建者（只读例外）可读取 private 对话的记录与动图文件
  const creatorPriv = await fetch(`${base}/agent/v1/conversations/${conv1}/visuals/${vid}`, {
    headers: { Authorization: 'Bearer tk-creator' },
  });
  assert.equal(creatorPriv.status, 200);
  const creatorPrivBody = await creatorPriv.json();
  assert.equal(creatorPrivBody.aclRevision, 2);
  assert.equal(creatorPrivBody.creatorReadOnly, true);

  const creatorGif = await fetch(`${base}${creatorPrivBody.record.after.gif}`, {
    headers: { Authorization: 'Bearer tk-creator' },
  });
  assert.equal(creatorGif.status, 200);
  assert.equal(Buffer.from(await creatorGif.arrayBuffer()).equals(gifBytes), true);

  // 3) 跨对话（conv2 读 conv1 的 visualId）与跨项目（tk-proj-b）一律被拒
  const crossConv = await fetch(`${base}/agent/v1/conversations/${conv2}/visuals/${vid}`, {
    headers: { Authorization: 'Bearer tk-owner' },
  });
  assert.equal(crossConv.status, 404, '跨对话读取同一项目的 visualId 被 404 拒绝');

  const crossConvFile = await fetch(`${base}/agent/v1/conversations/${conv2}/visuals/${vid}/files/${generated.gif.split('?')[0].split('/').pop()}`, {
    headers: { Authorization: 'Bearer tk-owner' },
  });
  assert.equal(crossConvFile.status, 404, '跨对话读取文件被 404 拒绝');

  const crossProj = await fetch(`${base}/agent/v1/conversations/${conv1}/visuals/${vid}`, {
    headers: { Authorization: 'Bearer tk-proj-b' },
  });
  assert.equal(crossProj.status, 404, '跨项目读取被 404 拒绝');

  // 4) 被踢出项目或未携带有效票据被拒
  const noToken = await fetch(`${base}/agent/v1/conversations/${conv1}/visuals/${vid}`);
  assert.equal(noToken.status, 401);

  kickedAccounts.add('acct_creator');
  const kickedCreator = await fetch(`${base}/agent/v1/conversations/${conv1}/visuals/${vid}`, {
    headers: { Authorization: 'Bearer tk-creator' },
  });
  assert.equal(kickedCreator.status, 403, '被踢后立即 403 拒绝');
  kickedAccounts.delete('acct_creator');

  // 5) 重启后持久保留：关闭原 provider 与路由，仅从磁盘 dataDir 重建
  await visuals.close('restart');
  visuals = null;
  routes = makeRoutes();

  const afterRestart = await fetch(`${base}/agent/v1/conversations/${conv1}/visuals/${vid}`, {
    headers: { Authorization: 'Bearer tk-owner' },
  });
  assert.equal(afterRestart.status, 200, '服务重启后记录仍持久可读');
  const afterRestartBody = await afterRestart.json();
  const afterRestartGif = await fetch(`${base}${afterRestartBody.record.after.gif}`, {
    headers: { Authorization: 'Bearer tk-owner' },
  });
  assert.equal(afterRestartGif.status, 200, '服务重启后动图文件仍持久可读');
  assert.equal(Buffer.from(await afterRestartGif.arrayBuffer()).equals(gifBytes), true);

  // 6) 前端 ToolVisual.tsx 云端模式加载与共有切私有撤权清理验证
  const vite = await createServer({ server: { middlewareMode: true, hmr: false }, appType: 'custom', logLevel: 'silent' });
  t.after(() => vite.close());
  const {
    clearVisualCache,
    loadVisualRecord,
    peekVisualRecord,
    setCloudVisualScope,
    visualIdOf,
  } = await vite.ssrLoadModule('/src/editor/right/ToolVisual.tsx');

  assert.equal(visualIdOf(JSON.stringify({ ok: true, visualId: vid })), vid);
  conv1Visibility = 'shared';
  conv1AclRev = 3;

  setCloudVisualScope({
    baseUrl: `${base}/agent/v1`,
    projectId: projA,
    conversationId: conv1,
    accountId: 'acct_member',
    aclRevision: 3,
    visibility: 'shared',
    ticket: async () => 'tk-member',
  });
  t.after(() => {
    setCloudVisualScope(null);
    clearVisualCache();
  });

  const loadedRec = await loadVisualRecord(vid);
  assert.equal(loadedRec.tool, 'get_gif');
  assert.ok(loadedRec.after?.gif.startsWith('blob:') || loadedRec.after?.gif.startsWith('data:'));
  assert.equal(peekVisualRecord(vid), loadedRec, 'shared 状态下缓存命中');

  // 当对话切为 private、普通成员被撤权时，setCloudVisualScope 立即清空缓存且再次加载被拒
  conv1Visibility = 'private';
  conv1AclRev = 4;
  setCloudVisualScope({
    baseUrl: `${base}/agent/v1`,
    projectId: projA,
    conversationId: conv1,
    accountId: 'acct_member',
    aclRevision: 4,
    visibility: 'private',
    revoked: true,
    ticket: async () => 'tk-member',
  });
  assert.equal(peekVisualRecord(vid), undefined, '切私有撤权后缓存立即被清空，不残留');
  await assert.rejects(loadVisualRecord(vid), /无法读取/);
});
