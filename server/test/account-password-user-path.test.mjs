import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import { startAccountPasswordUserFixture } from './fixtures/account-password-user-path.mjs';

const ports = [6680, 6681, 6682, 6683, 6684, 6685, 6686];

function jsonRequest(url, { method = 'GET', body, headers = {}, ca } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const req = https.request(url, { method, ca, rejectUnauthorized: true, timeout: 5000,
      headers: { ...(data === null ? {} : { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) }), ...headers } }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.once('error', reject);
      res.once('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
          cookie: res.headers['set-cookie']?.[0]?.split(';')[0] }); } catch { reject(Error('invalid-json-response')); }
      });
    });
    req.once('error', reject);
    req.once('timeout', () => req.destroy(Error('account-request-timeout')));
    req.end(data);
  });
}

function websiteActor(origin, ca) {
  let cookie = '', csrf = '';
  const request = async (method, route, body) => {
    const response = await jsonRequest(`${origin}/api/account${route}`, { method, body, ca, headers: {
      ...(cookie ? { cookie } : {}), ...(method === 'POST' ? { origin,
        'sec-fetch-site': 'same-origin', ...(csrf ? { 'x-csrf-token': csrf } : {}) } : {}) } });
    if (response.cookie) cookie = response.cookie;
    if (response.body.csrfToken) csrf = response.body.csrfToken;
    return response;
  };
  return { request };
}

test('改密退出只保留发起网站会话并撤销其它网站与在线编辑器登录', async t => {
  const fixture = await startAccountPasswordUserFixture({ ports, agentPort: 6687,
    diagnostic: data => t.diagnostic(JSON.stringify(data)) });
  try {
    const accounts = fixture.accounts;
    const ca = await fs.readFile(fixture.caFile);
    assert.equal(fixture.readControlReady, true);
    const initiator = websiteActor(fixture.origin, ca);
    const otherOne = websiteActor(fixture.origin, ca);
    const otherTwo = websiteActor(fixture.origin, ca);
    await Promise.all([initiator, otherOne, otherTwo].map(actor => actor.request('GET', '/me')));
    const login = actor => actor.request('POST', '/login', { name: accounts[0].name, password: accounts[0].password, remember: true });
    assert.equal((await login(initiator)).status, 200);
    assert.equal((await login(otherOne)).status, 200);
    assert.equal((await login(otherTwo)).status, 200);

    const editor = await initiator.request('POST', '/editor/session', {
      deviceId: 'password-user-editor-device', deviceName: 'Password path browser', requestId: 'password-editor-session' });
    assert.equal(editor.status, 200);
    const before = await jsonRequest(`${fixture.origin}/hosted/shared/account/session`, { method: 'POST', ca,
      headers: { authorization: `Bearer ${editor.body.accessToken}`, 'content-type': 'application/json' },
      body: { projectId: fixture.projectId, deviceId: 'password-user-editor-device', requestId: 'password-editor-project-session' } });
    assert.equal(before.status, 200);

    const changed = await initiator.request('POST', '/password', {
      current: accounts[0].password, next: accounts[0].nextPassword, requestId: 'password-user-change' });
    assert.equal(changed.status, 200);
    assert.equal(changed.body.choice, 'pending');
    const choice = await initiator.request('POST', `/password-events/${encodeURIComponent(changed.body.passwordEventId)}/choice`, {
      exitOthers: true, requestId: 'password-user-exit-choice' });
    assert.equal(choice.status, 202, '退出选择已受理，服务确认尚未完成时应保持进行中');
    assert.equal(choice.body.choice, 'exit');

    const [initiatorMe, oldOneMe, oldTwoMe] = await Promise.all([
      initiator.request('GET', '/me'), otherOne.request('GET', '/me'), otherTwo.request('GET', '/me')]);
    assert.equal(initiatorMe.status, 200);
    assert.ok(initiatorMe.body.account);
    assert.equal(oldOneMe.body.account, null);
    assert.equal(oldTwoMe.body.account, null);
    const editorLost = await jsonRequest(`${fixture.origin}/hosted/shared/account/session`, { method: 'POST', ca,
      headers: { authorization: `Bearer ${editor.body.accessToken}`, 'content-type': 'application/json' },
      body: { projectId: fixture.projectId, deviceId: 'password-user-editor-device', requestId: 'password-editor-after-exit' } });
    assert.equal(editorLost.status, 401);

    const oldPassword = websiteActor(fixture.origin, ca);
    const newPassword = websiteActor(fixture.origin, ca);
    await Promise.all([oldPassword, newPassword].map(actor => actor.request('GET', '/me')));
    assert.equal((await oldPassword.request('POST', '/login', { name: accounts[0].name, password: accounts[0].password })).status, 401);
    assert.equal((await newPassword.request('POST', '/login', { name: accounts[0].name, password: accounts[0].nextPassword })).status, 200);
    const event = await initiator.request('GET', `/password-events/${encodeURIComponent(changed.body.passwordEventId)}`);
    assert.equal(event.body.choice, 'exit');
    assert.notEqual(event.body.logout?.state, 'complete', 'without all real durable service ACKs the UI must remain pending');

    await Promise.all([otherOne, otherTwo].map(actor => actor.request('GET', '/me')));
    assert.equal((await otherOne.request('POST', '/login', { name: accounts[0].name, password: accounts[0].nextPassword })).status, 200);
    assert.equal((await otherTwo.request('POST', '/login', { name: accounts[0].name, password: accounts[0].nextPassword })).status, 200);
    const resetEditor = await otherOne.request('POST', '/editor/session', {
      deviceId: 'password-reset-editor-device', deviceName: 'Reset path browser', requestId: 'password-reset-editor-session' });
    assert.equal(resetEditor.status, 200);
    const resetEditorSession = await jsonRequest(`${fixture.origin}/hosted/shared/account/session`, { method: 'POST', ca,
      headers: { authorization: `Bearer ${resetEditor.body.accessToken}`, 'content-type': 'application/json' },
      body: { projectId: fixture.projectId, deviceId: 'password-reset-editor-device', requestId: 'password-reset-project-session' } });
    assert.equal(resetEditorSession.status, 200);

    const email = `password-path-${randomUUID().replaceAll('-', '').slice(0, 18)}@example.invalid`;
    assert.equal((await initiator.request('POST', '/email/start', { email, password: accounts[0].nextPassword })).status, 200);
    const bindCode = fixture.takeIssuedCode(email, 'bind');
    assert.match(bindCode ?? '', /^\d{6}$/);
    assert.equal((await initiator.request('POST', '/email/confirm', { code: bindCode })).status, 200);
    assert.equal((await initiator.request('POST', '/reset/start', { name: accounts[0].name })).status, 200);
    const resetCode = fixture.takeIssuedCode(email, 'reset');
    assert.match(resetCode ?? '', /^\d{6}$/);
    const reset = await initiator.request('POST', '/reset/confirm', { name: accounts[0].name, code: resetCode,
      password: accounts[0].resetPassword, requestId: 'password-user-reset' });
    assert.equal(reset.status, 200);
    assert.equal(reset.body.choice, 'pending');
    const resetChoice = await initiator.request('POST', `/password-events/${encodeURIComponent(reset.body.passwordEventId)}/choice`, {
      exitOthers: true, requestId: 'password-user-reset-exit-choice' });
    assert.equal(resetChoice.status, 202);
    assert.equal(resetChoice.body.choice, 'exit');
    const [resetInitiatorMe, resetOldOneMe, resetOldTwoMe] = await Promise.all([
      initiator.request('GET', '/me'), otherOne.request('GET', '/me'), otherTwo.request('GET', '/me')]);
    assert.ok(resetInitiatorMe.body.account);
    assert.equal(resetOldOneMe.body.account, null);
    assert.equal(resetOldTwoMe.body.account, null);
    const resetEditorLost = await jsonRequest(`${fixture.origin}/hosted/shared/account/session`, { method: 'POST', ca,
      headers: { authorization: `Bearer ${resetEditor.body.accessToken}`, 'content-type': 'application/json' },
      body: { projectId: fixture.projectId, deviceId: 'password-reset-editor-device', requestId: 'password-reset-editor-after-exit' } });
    assert.equal(resetEditorLost.status, 401);
    const preResetPassword = websiteActor(fixture.origin, ca), resetPassword = websiteActor(fixture.origin, ca);
    await Promise.all([preResetPassword, resetPassword].map(actor => actor.request('GET', '/me')));
    assert.equal((await preResetPassword.request('POST', '/login', { name: accounts[0].name, password: accounts[0].nextPassword })).status, 401);
    assert.equal((await resetPassword.request('POST', '/login', { name: accounts[0].name, password: accounts[0].resetPassword })).status, 200);
    const resetEvent = await initiator.request('GET', `/password-events/${encodeURIComponent(reset.body.passwordEventId)}`);
    assert.equal(resetEvent.body.choice, 'exit');
    assert.notEqual(resetEvent.body.logout?.state, 'complete');
    t.diagnostic(JSON.stringify({ check: 'password-change-route', eventChoice: event.body.choice,
      logoutState: event.body.logout?.state ?? 'unreported', retainedInitiator: Boolean(initiatorMe.body.account),
      oldSiteSessionsRevoked: !oldOneMe.body.account && !oldTwoMe.body.account, oldEditorRevoked: editorLost.status === 401,
      newPasswordLogin: true, oldPasswordRejected: true, resetCodeProviderIssuedAndAccepted: true,
      resetDelivery: 'private-test-mail-callback; no external SMTP delivery', resetInitiatorRetained: Boolean(resetInitiatorMe.body.account),
      resetOtherSiteSessionsRevoked: !resetOldOneMe.body.account && !resetOldTwoMe.body.account,
      resetEditorRevoked: resetEditorLost.status === 401, resetNewPasswordLogin: true, previousPasswordRejected: true,
      readControlReady: fixture.readControlReady, changeLogoutState: event.body.logout?.state ?? 'unreported',
      resetLogoutState: resetEvent.body.logout?.state ?? 'unreported' }));
  } finally {
    await fixture.close();
  }
});
