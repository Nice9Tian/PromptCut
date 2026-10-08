import test from 'node:test';
import assert from 'node:assert/strict';
import { runAccountDualUserPath } from './fixtures/account-dual-user-path.mjs';

test('真实双账号网站列表与文档创建/加入/会话经独立素材追头开放', { timeout: 90_000 }, async t => {
  let staticCalls = 0;
  const result = await runAccountDualUserPath({ diagnostic: data => t.diagnostic(JSON.stringify(data)),
    publicHandler(req, res) {
      staticCalls++;
      if (req.url !== '/editor') return false;
      res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>fixture page</title>');
      return true;
    } });
  assert.equal(result.created, 201);
  assert.equal(result.blockedJoin, 503);
  assert.equal(result.joined, 200);
  assert.deepEqual(result.sessions, [200, 200]);
  assert.equal(result.ownerProjects, 1);
  assert.equal(result.memberProjects, 1);
  assert.equal(result.accountCookie, 200);
  assert.equal(result.mediaWithWebsiteCookie, 200);
  assert.equal(result.mediaWithInvalidTicket, 401);
  assert.equal(result.webSocketProjectRevision, 1);
  assert.equal(result.publicHandlerServed, true);
  assert.equal(staticCalls, 1, 'only the non-API editor page reached the public handler');
  assert.equal(result.revokedSession, 401);
  assert.equal(result.assetOfflineSession, 503);
  assert.equal(result.childClosed, true);
});
