import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccountDualUserPath } from '../../scripts/probes/account-dual-user-path-probe.mjs';

test('真实双账号网站列表与文档创建/加入/会话经独立素材追头开放', { timeout: 90_000 }, async t => {
  const result = await runAccountDualUserPath({ diagnostic: data => t.diagnostic(JSON.stringify(data)) });
  assert.equal(result.created, 201);
  assert.equal(result.blockedJoin, 503);
  assert.equal(result.joined, 200);
  assert.deepEqual(result.sessions, [200, 200]);
  assert.equal(result.ownerProjects, 1);
  assert.equal(result.memberProjects, 1);
  assert.equal(result.accountCookie, 200);
  assert.equal(result.mediaWithWebsiteCookie, 200);
  assert.equal(result.mediaWithInvalidTicket, 401);
  assert.equal(result.revokedSession, 401);
  assert.equal(result.assetOfflineSession, 503);
  assert.equal(result.childClosed, true);
});
