import assert from 'node:assert/strict';
import { instanceDataHttpRequest, instanceWsClient } from './agent-instance-data.mjs';

export async function exerciseInstanceData({ port, tls, instance, grant, own }) {
  const { projectId, runGrantId } = grant, clients = [];
  const connect = async (extra = {}) => { const c = await instanceWsClient({ port, tls, instance, projectId, runGrantId, nonce: 1, ...extra });
    own(c); clients.push(c); return c; };
  const client = await connect(); assert.equal(client.status, 101);
  const welcome = await client.next(msg => msg.type === 'session.welcome'); assert.match(welcome.connId, /^conn-/);
  const send = async (frame, nonce) => { client.send(client.envelope({ connId: welcome.connId, nonce, frame })); return client.next(msg => msg.reqId === frame.reqId); };
  const opened = await send({ type: 'project.open', projectId, reqId: 'data-open', seq: 1, ack: 0 }, 2);
  assert.equal(opened.type, 'project.state', JSON.stringify({ type: opened.type, reason: opened.reason })); assert.equal(opened.rev, 2);
  const selection = await send({ type: 'selection.query', projectId, runGrantId, reqId: 'data-selection', seq: 2, ack: 0 }, 3);
  assert.equal(selection.type, 'selection.state', JSON.stringify(selection));
  assert.equal(selection.members.find(member => member.isInitiator)?.accountId, grant.accountId);
  const written = await send({ type: 'project.op', projectId, opId: 'actual-instance-op', reqId: 'data-write', seq: 3, ack: 0,
    ops: [{ op: 'set', path: '/agentVerified', value: true }] }, 4);
  assert.equal(written.type, 'project.op.ok', JSON.stringify(written)); assert.equal(written.rev, 3);
  const frames = [{ type: 'project.open', projectId, reqId: 'parallel-4', seq: 4, ack: 0 },
    { type: 'project.open', projectId, reqId: 'parallel-5', seq: 5, ack: 0 }];
  for (const [index, frame] of frames.entries()) client.send(client.envelope({ connId: welcome.connId, nonce: 5 + index, frame }));
  for (const frame of frames) assert.equal((await client.next(msg => msg.reqId === frame.reqId)).rev, 3, 'full frame invocations preserve FIFO');
  const resumed = await connect({ nonce: 7, sessionItem: { sid: welcome.sid, ack: 0 },
    protocols: ['promptcut.v1', `promptcut.session.${welcome.sid}.0`] });
  assert.equal((await resumed.next(msg => msg.type === 'session.welcome')).connId, welcome.connId);
  await client.ended; assert.equal(client.closeFrame.code, 4009);
  const resumeFrame = { type: 'project.open', projectId, reqId: 'resumed-6', seq: 6, ack: 0 };
  resumed.send(resumed.envelope({ connId: welcome.connId, nonce: 8, frame: resumeFrame }));
  assert.equal((await resumed.next(msg => msg.reqId === resumeFrame.reqId)).rev, 3);

  for (const negative of ['read-write', 'missing-query', 'changed-seq', 'changed-ack', 'nonce-replay', 'cross-tls']) {
    const c = await connect(), w = await c.next(msg => msg.type === 'session.welcome');
    let frame = { type: 'project.open', projectId, reqId: negative, seq: 1, ack: 0 }, envelope;
    if (negative === 'read-write') { frame = { ...frame, type: 'project.op', opId: negative, ops: [{ op: 'set', path: '/shouldNotExist', value: true }] };
      envelope = c.envelope({ connId: w.connId, nonce: 2, frame, actionOverride: 'read' }); }
    else if (negative === 'missing-query') { frame = { ...frame, type: 'selection.query', runGrantId };
      envelope = c.envelope({ connId: w.connId, nonce: 2, frame, omitQuery: true }); }
    else if (negative === 'changed-seq' || negative === 'changed-ack') {
      envelope = c.envelope({ connId: w.connId, nonce: 2, frame }); envelope.frame = { ...frame, [negative === 'changed-seq' ? 'seq' : 'ack']: 9 };
    } else if (negative === 'cross-tls') envelope = resumed.envelope({ connId: w.connId, nonce: 2, frame });
    else { envelope = c.envelope({ connId: w.connId, nonce: 2, frame }); c.send(envelope);
      assert.equal((await c.next(msg => msg.reqId === negative)).type, 'project.state'); }
    c.send(envelope); await c.ended; assert.equal(c.closeFrame.code, 4003, negative);
    assert.equal(c.all.some(msg => msg.reqId === negative && msg.type === 'project.op.ok'), false);
  }
  assert.equal((await connect({ signedUrl: `/?projectId=${projectId}&runGrantId=${runGrantId}&nonce=99` })).status, 401, 'changed query rejected at handshake');
  assert.equal((await connect({ signedProtocols: ['promptcut.v1', 'promptcut.session.new', 'changed'] })).status, 401, 'changed protocol tuple rejected');

  const lpUrl = nonce => `/lp/open?projectId=${projectId}&runGrantId=${runGrantId}&nonce=${nonce}`;
  const protocols = { 'x-promptcut-protocols': 'promptcut.v1, promptcut.session.new' };
  const request = extra => instanceDataHttpRequest({ port, tls, instance, projectId, runGrantId, ...extra });
  const lp = await request({ kind: 'connection', nonce: 20, url: lpUrl(20), body: {}, headers: protocols });
  assert.equal(lp.status, 200, JSON.stringify(lp.body)); const auth = { authorization: `Bearer ${lp.body.sid}` };
  const lpFrame = JSON.stringify({ type: 'project.open', projectId, reqId: 'lp-open', seq: 1, ack: 0 });
  assert.equal((await request({ kind: 'message', nonce: 21, connId: lp.body.connId, url: '/lp/send',
    body: { frames: [lpFrame] }, headers: auth })).body.ack, 1);
  const got = await request({ kind: 'recv', nonce: 22, connId: lp.body.connId, url: '/lp/recv?ack=0&wait=0', headers: auth });
  assert.equal(got.status, 200); assert.ok(got.body.frames.some(text => JSON.parse(text).reqId === 'lp-open'));
  assert.equal((await request({ kind: 'recv', nonce: 23, connId: lp.body.connId, url: '/lp/recv?ack=0&wait=0',
    signedUrl: '/lp/recv?ack=999&wait=0', headers: auth })).status, 403, 'changed ack/query does not mutate cache');
  assert.equal((await request({ kind: 'message', nonce: 24, connId: lp.body.connId, url: '/lp/send', body: { frames: [lpFrame] },
    signedBodyText: JSON.stringify({ frames: ['changed'] }), headers: auth })).status, 403, 'complete original body is signed');
  assert.equal((await request({ kind: 'message', nonce: 25, connId: lp.body.connId, url: '/lp/send', body: { frames: [lpFrame] },
    signedHeaders: { ...auth, 'x-promptcut-fallback': 'changed' }, headers: auth })).status, 403, 'protocol tuple is signed');
  assert.equal((await request({ kind: 'recv', nonce: 22, connId: lp.body.connId, url: '/lp/recv?ack=0&wait=0', headers: auth })).status, 403, 'nonce replay rejected');
  const resumedLp = await request({ kind: 'resume', nonce: 26, connId: lp.body.connId, url: lpUrl(26), body: {},
    headers: { 'x-promptcut-protocols': `promptcut.v1, promptcut.session.${lp.body.sid}.0` }, sessionItem: { sid: lp.body.sid, ack: 0 } });
  assert.equal(resumedLp.status, 200, JSON.stringify(resumedLp.body)); assert.equal(resumedLp.body.connId, lp.body.connId);
  assert.equal((await request({ kind: 'close', nonce: 27, connId: lp.body.connId, url: '/lp/close', body: {}, headers: auth })).status, 200);
  for (const c of clients) c.destroy(); await Promise.all(clients.map(c => c.ended));
  return { written, expectedRev: 3, resumeIdentity: { sid: welcome.sid, connId: welcome.connId } };
}
