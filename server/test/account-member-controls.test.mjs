import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { mountAccountProjects } from '../docservice/modules/account-projects.mjs';

async function dispatch(mounted, body, options = {}) {
  const req = Readable.from([Buffer.from(JSON.stringify(body))]);
  Object.assign(req, { method: options.method ?? 'POST', url: options.path ?? '/hosted/shared/account/members',
    headers: { 'content-type': 'application/json', authorization: 'Bearer fixture-token', ...options.headers } });
  let status, value;
  const res = { writeHead: s => { status = s; }, end: text => { value = JSON.parse(text); } };
  assert.equal(await mounted.handlePublic(req, res), true);
  return { status, value };
}
test('members route authenticates bearer and passes only project body to trusted projection; cookies/claims/unknown/method/missing provider reject', async () => {
  const projectId = 'sp_' + 'a'.repeat(26); let received;
  const mounted = mountAccountProjects({ authority: {}, membersSnapshot: async (actor, body) => {
    received = { actor, body }; return { v: 2, projectId, members: [] };
  } });
  const ok = await dispatch(mounted, { projectId });
  assert.equal(ok.status, 200); assert.deepEqual(received, { actor: { accessToken: 'fixture-token' }, body: { projectId } });
  for (const claim of ['accountId', 'creator', 'principal', 'role', 'loginId', 'credentialId', 'authorizationId', 'runGrantId']) {
    assert.equal((await dispatch(mounted, { projectId, [claim]: 'untrusted' })).status, 400);
  }
  assert.equal((await dispatch(mounted, { projectId }, { headers: { cookie: 'fixture-cookie' } })).status, 400);
  assert.equal((await dispatch(mounted, { projectId }, { method: 'GET' })).status, 405);
  assert.equal((await dispatch(mounted, { projectId }, { path: '/hosted/shared/account/members/unknown' })).status, 404);
  assert.equal((await dispatch(mountAccountProjects({ authority: {} }), { projectId })).status, 503);
});
