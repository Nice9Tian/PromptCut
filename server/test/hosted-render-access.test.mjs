/**
 * 托管方渲染服务在项目里的权限：白名单、素材票据、开关、成员列表、空间隔离
 * （契约 `docs/plan/hosted-render-contract.md` 第 1.5～1.7、3 节；用例 HR8、HR10～HR13）。
 * 跑：npm test -- server/test/hosted-render-access.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  createProject, join, newDevice, adminOp, ask, members, ticketOf, parseTicket, tamperTicket, waitFor, sleep, bearer, PROTOCOL,
} from './auth-kit.mjs';
import { snapshotTaskInput } from './fake-ws-kit.mjs';
import {
  serviceHostFor, openControl, openData, outcome, requestServiceTicket, TICKET_PREFIX, ALL_TYPES,
} from './hosted-render-kit.mjs';
import { SERVICE_ALLOW, SERVICE_CONTROL_TYPES, RENDER_CONTENT_KINDS, serviceGate } from '../docservice/service-gate.mjs';

async function closedWithin(c, ms, what) {
  let timer;
  const e = await Promise.race([
    c.closed,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what}：${ms} ms 内没有关闭`)), ms); }),
  ]);
  clearTimeout(timer);
  return { code: e.code, reason: e.reason };
}

const sha256hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** 往素材服务写一件小东西（一片加收尾），回两步的状态码 */
async function upload(env, ns, headers, bytes = randomBytes(256)) {
  const hash = sha256hex(bytes);
  const put = await env.asset(`${ns}/${hash}/0`, { method: 'PUT', body: bytes, headers: { 'Content-Type': 'application/octet-stream', 'X-Media-Size': String(bytes.length), ...headers } });
  const done = put.status === 200 ? await env.asset(`${ns}/${hash}/complete`, { method: 'POST', headers }) : null;
  return { hash, put: put.status, complete: done?.status ?? null };
}

/** 起一个项目：创建者一条页面连接、渲染服务的控制连接与数据连接 */
async function setup(t, options) {
  const env = await serviceHostFor(t, options);
  const proj = await createProject(env, { mode: 'free' });
  const creator = await join(env, proj, { username: proj.creator.username, as: 'creator' });
  const control = await openControl(env, env.keys.render);
  const data = await openData(env, control, proj.projectId);
  return { env, proj, creator, control, data };
}

const PROJECT = 'doc-1';
const projectBody = () => ({ id: PROJECT, name: 'demo', tracks: [] });

// ------------------------------------------------------------------ HR8

test('HR8 白名单（纯函数）：渲染服务的表、控制连接的表；不是服务身份的连接不受影响，但发 hosted.* 一律拒', () => {
  assert.deepEqual([...SERVICE_CONTROL_TYPES], ['hosted.watch', 'hosted.ticket', 'hosted.demand', 'hosted.delegate.verify']);
  assert.deepEqual([...SERVICE_ALLOW.render].sort(), [
    'auth.ticket', 'content.get', 'content.list', 'content.put', 'content.watch',
    'node.active', 'node.hello', 'project.close', 'project.open', 'project.snapshot.get',
    'publisher.hello', 'queue.watch', 'service.watch',
    'task.claim', 'task.complete', 'task.fail', 'task.progress', 'task.publish', 'task.release',
  ]);
  assert.deepEqual([...RENDER_CONTENT_KINDS], ['snapshot-manifest', 'render-manifest']);
  const render = { scope: 'service', service: 'render', tenantId: 'sp_aaaaaaaaaaaaaaaaaaaaaaaaaa', role: 'render' };
  const control = { scope: 'service', service: 'render', tenantId: null };
  for (const type of ALL_TYPES) {
    const expected = SERVICE_ALLOW.render.includes(type) ? undefined : 'forbidden';
    if (expected) assert.equal(serviceGate(render, type, { type }), 'forbidden', `渲染服务发 ${type}`);
    assert.equal(serviceGate(control, type, { type }), 'forbidden', `控制连接发 ${type}`);
    assert.equal(serviceGate({ scope: 'member', tenantId: render.tenantId, role: 'render' }, type, { type }), null, `成员发 ${type} 不归这里管`);
  }
  assert.equal(serviceGate({ scope: 'service', service: 'unknown', tenantId: render.tenantId }, 'project.open', {}), 'forbidden', '没有白名单的服务什么都不能发');
  // 按 service 字段判，不按 scope：代成员进来的服务连接（scope 是 member）同样走白名单。agent 一行由第四段填
  // （`cloud-agent-auth.test.mjs` 的 CA-AUTH-05 逐条测）；这里只钉「表里没有的服务名全拒」
  for (const type of ALL_TYPES) {
    assert.equal(serviceGate({ scope: 'member', service: 'backup', tenantId: render.tenantId, role: 'agent', conversation: 1 }, type, { type }), 'forbidden', '表里没有的服务发 ' + type);
  }
  for (const p of [{ scope: 'member', tenantId: render.tenantId }, { scope: 'admin', tenantId: null }, { scope: 'local', tenantId: 'local' }, render]) {
    assert.equal(serviceGate(p, 'hosted.watch', {}), 'forbidden', `${p.scope} 发 hosted.watch`);
  }
  // 三种要看内容的消息
  for (const kind of ['card-source', 'event-detail', undefined]) assert.equal(serviceGate(render, 'content.put', { kind }), 'forbidden', `content.put ${kind}`);
  for (const kind of RENDER_CONTENT_KINDS) assert.equal(serviceGate(render, 'content.put', { kind }), null);
  assert.equal(serviceGate(render, 'auth.ticket', { kind: 'asset' }), null);
  for (const kind of ['conn', undefined]) assert.equal(serviceGate(render, 'auth.ticket', { kind }), 'forbidden', `auth.ticket ${kind}`);
  assert.equal(serviceGate(render, 'task.publish', { tasks: [{ kind: 'snapshot' }] }), null);
  assert.equal(serviceGate(render, 'task.publish', { tasks: [{ kind: 'snapshot' }, { kind: 'plan' }] }), 'forbidden');
});

test('HR8 渲染服务的数据连接：表内的消息都不被拒；表外逐个 forbidden；提交编辑被拒且项目内容与版本号不变', async (t) => {
  const { env, proj, creator, data } = await setup(t);
  // 创建者先放一份项目内容
  const init = await ask(creator, { type: 'project.op', projectId: PROJECT, opId: 'op-init', session: 's-c', ops: [{ op: 'set', path: '', value: projectBody() }] }, ['project.op.ok', 'project.op.rejected']);
  assert.equal(init.type, 'project.op.ok', JSON.stringify(init));
  const stateOf = async (c) => ask(c, { type: 'project.open', projectId: PROJECT }, 'project.state');
  const before = await stateOf(creator);

  // 表外：逐个 forbidden
  const outside = ALL_TYPES.filter((type) => !SERVICE_ALLOW.render.includes(type));
  for (const type of outside) {
    assert.equal(await outcome(data, { type, projectId: PROJECT, kind: 'asset' }), 'error:forbidden', type);
  }
  for (const type of ['hosted.watch', 'hosted.ticket', 'hosted.demand']) assert.equal(await outcome(data, { type, projectId: proj.projectId }), 'error:forbidden', type);

  // 四个原有的口子，各一条带真实负载的拒绝
  const edit = await ask(data, { type: 'project.op', projectId: PROJECT, opId: 'op-evil', session: 's-r', ops: [{ op: 'set', path: '/name', value: 'hacked' }] }, ['project.op.ok', 'project.op.rejected']);
  assert.deepEqual([edit.type, edit.reason], ['error', 'forbidden'], `用服务身份提交编辑：${JSON.stringify(edit)}`);
  assert.equal(await outcome(data, { type: 'project.announce', projectId: PROJECT, digest: 'a'.repeat(64), session: 's-r' }), 'error:forbidden', '口子：project.announce');
  assert.equal(await outcome(data, { type: 'content.put', kind: 'card-source', key: 'src/cards/user/evil.card.tsx', body: { source: 'export default 1' } }), 'error:forbidden', '口子：content.put 写卡片源码');
  assert.equal(await outcome(data, { type: 'content.put', kind: 'event-detail', key: 'e1', body: {} }), 'error:forbidden');
  assert.equal(await outcome(data, { type: 'auth.ticket', kind: 'conn', role: 'page' }), 'error:forbidden', '口子：给自己签 page 角色的连接票据');
  assert.equal(await outcome(data, { type: 'auth.ticket', kind: 'conn', role: 'render' }), 'error:forbidden');
  assert.equal(await outcome(data, { type: 'shared.challenge' }), 'error:forbidden');
  assert.equal(await outcome(data, { type: 'service.announce', kind: 'asset', urls: ['http://evil.example/api/asset'] }), 'error:forbidden');
  assert.equal(await outcome(data, { type: 'cost.put', projectId: proj.projectId, records: [] }), 'error:forbidden');

  const after = await stateOf(creator);
  assert.equal(after.rev, before.rev, '版本号不变');
  assert.deepEqual(after.project ?? after.body ?? after.state, before.project ?? before.body ?? before.state, '项目内容不变');
  assert.equal(JSON.stringify(after).includes('hacked'), false);

  // 表内：都不被白名单拒（形状不对由各模块自己回 bad-message，不是 forbidden）
  const allowed = {
    'node.hello': { nodeId: 'hosted-render:t/a', profile: 'host' },
    'node.active': { busy: 'bake' },
    'queue.watch': { projects: 'all' },
    'publisher.hello': { publisherId: 'hosted-render:t/a' },
    'project.open': { projectId: PROJECT },
    'project.snapshot.get': { projectId: PROJECT, projectRev: 1 },
    'project.close': { projectId: PROJECT },
    'content.put': { kind: 'snapshot-manifest', key: 'layers:doc-1', body: { v: 3, layers: [] } },
    'content.get': { kind: 'snapshot-manifest', key: 'layers:doc-1' },
    'content.list': { kind: 'card-source' },
    'content.watch': { kinds: ['card-source'] },
    'service.watch': { kinds: 'all' },
    'auth.ticket': { kind: 'asset', access: 'rw' },
    'task.claim': { id: 'snapshot:none:0-1', expectVersion: 1 },
    'task.progress': { id: 'snapshot:none:0-1', token: 1, done: 1 },
    'task.complete': { id: 'snapshot:none:0-1', token: 1 },
    'task.fail': { id: 'snapshot:none:0-1', token: 1, error: 'x' },
    'task.release': { id: 'snapshot:none:0-1', token: 1 },
  };
  for (const [type, body] of Object.entries(allowed)) {
    data.send({ type, ...body, reqId: `hr8-${type}` });
    let reply = null;
    try { reply = await data.next((m) => m?.reqId === `hr8-${type}`, 600); } catch { reply = null; } // node.active 不回包
    assert.notEqual(reply?.reason, 'forbidden', `${type}：${JSON.stringify(reply)}`);
    assert.notEqual(reply?.reason, 'service-disabled', type);
  }
  assert.deepEqual(Object.keys(allowed).concat('task.publish').sort(), [...SERVICE_ALLOW.render].sort(), '表内的每一种都发过');

  // task.publish：细任务可以，计划任务被拒
  const fine = snapshotTaskInput({ resultKey: `rk-hr8-${Date.now()}`, projectId: PROJECT });
  assert.equal(await outcome(data, { type: 'task.publish', tasks: [fine] }, 'task.published'), 'task.published', '发布自己切出来的细任务');
  const plan = { id: `plan:${PROJECT}@1`, kind: 'plan', resultKey: `${PROJECT}@1`, range: null, source: { projectId: PROJECT, projectRev: 1 }, weight: { class: 'light' }, requires: {} };
  assert.equal(await outcome(data, { type: 'task.publish', tasks: [plan] }), 'error:forbidden', '发布计划任务');
  // 成员照常能做这些（没有被白名单误伤）
  assert.equal(await outcome(creator, { type: 'content.put', kind: 'card-source', key: 'src/cards/user/ok.card.tsx', body: { source: 'x' } }, 'content.stored'), 'content.stored');
  const names = env.principals().filter((p) => p.tenantId === proj.projectId).map((p) => p.scope).sort();
  assert.deepEqual(names, ['member', 'service']);
});

// ------------------------------------------------------------------ HR10

test('HR10 素材票据：带 sv / sk；读任意命名空间通，写 snap、px 通，写 media 403；只读票据写 403；关开关或撤公钥后同一张票据当场 401', async (t) => {
  const { env, proj, creator, data } = await setup(t, { assets: true });
  const rw = await ask(data, { type: 'auth.ticket', kind: 'asset', access: 'rw' }, 'auth.ticket.ok');
  assert.equal(rw.type, 'auth.ticket.ok', JSON.stringify(rw));
  const body = parseTicket(rw.ticket).body;
  assert.deepEqual(
    { k: body.k, p: body.p, u: body.u, r: body.r, sv: body.sv, sk: body.sk },
    { k: 'asset', p: proj.projectId, u: `service:render@${env.keys.render.instanceId}`, r: 'rw', sv: 'render', sk: env.keys.render.kid },
  );
  assert.equal(body.exp - body.iat, 15 * 60_000);

  // 成员先放一件素材原件，服务能读
  const memberRw = await ticketOf(creator, { kind: 'asset', access: 'rw' });
  assert.equal('sv' in parseTicket(memberRw.ticket).body, false, '成员的素材票据不带 sv');
  const media = await upload(env, 'media', bearer(memberRw.ticket));
  assert.deepEqual([media.put, media.complete], [200, 200], '成员写 media');
  assert.equal((await env.asset(`media/${media.hash}`, { headers: bearer(rw.ticket) })).status, 200, '服务读 media');

  for (const ns of ['snap', 'px']) {
    const r = await upload(env, ns, bearer(rw.ticket));
    assert.deepEqual([r.put, r.complete], [200, 200], `服务写 ${ns}`);
    assert.equal((await env.asset(`${ns}/${r.hash}`, { headers: bearer(rw.ticket) })).status, 200, `服务读 ${ns}`);
  }
  const denied = await upload(env, 'media', bearer(rw.ticket));
  assert.equal(denied.put, 403, '服务写 media');
  const bytes = randomBytes(64);
  assert.equal((await env.asset(`media/${sha256hex(bytes)}/complete`, { method: 'POST', headers: bearer(rw.ticket) })).status, 403, '服务对 media 收尾');
  assert.equal((await env.asset(`media/${media.hash}`, { method: 'DELETE', headers: bearer(rw.ticket) })).status, 405, '素材服务没有删除接口');

  const ro = await ask(data, { type: 'auth.ticket', kind: 'asset' }, 'auth.ticket.ok');
  assert.equal(parseTicket(ro.ticket).body.r, 'r', '不给 access 是只读');
  assert.equal((await upload(env, 'px', bearer(ro.ticket))).put, 403, '只读票据写入');
  assert.equal((await env.asset(`media/${media.hash}?t=${encodeURIComponent(ro.ticket)}`)).status, 200, '只读票据走查询串读');
  assert.equal((await env.asset(`media/${media.hash}`, { headers: bearer(tamperTicket(rw.ticket, { sv: undefined, sk: undefined, u: 'mia@dev-0000000000000000' })) })).status, 401, '改过负载的票据');

  // 关开关：同一张票据当场失效（不等 15 分钟）
  const off = await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false });
  assert.equal(off.type, 'shared.admin.ok');
  assert.equal((await env.asset(`media/${media.hash}`, { headers: bearer(rw.ticket) })).status, 401, '关掉后读');
  assert.equal((await upload(env, 'px', bearer(rw.ticket))).put, 401, '关掉后写');
  assert.equal((await env.asset(`media/${media.hash}`, { headers: bearer(memberRw.ticket) })).status, 200, '成员的票据不受影响');
  await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: true });
  assert.equal((await env.asset(`media/${media.hash}`, { headers: bearer(rw.ticket) })).status, 200, '再打开后同一张票据又有效');
  // 撤公钥：当场失效
  env.retire('render', env.keys.render.kid);
  assert.equal((await env.asset(`media/${media.hash}`, { headers: bearer(rw.ticket) })).status, 401, '撤公钥后');
});

// ------------------------------------------------------------------ HR11

test('HR11 开关：只有带创建者证明能改；不加代数、成员连接不断；关掉后服务连接 4003、认领立即放回、握手与取票据被拒、成员收到通知；再开能进', async (t) => {
  const { env, proj, creator, control, data } = await setup(t);
  const member = await join(env, proj, { username: 'mia' });
  const generation = env.store.peek(proj.projectId).generation;

  for (const [what, opts] of [['不带证明', { noProof: true }], ['证明错', { badProof: true }]]) {
    const r = await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false }, opts);
    assert.deepEqual([r.type, r.reason], ['error', 'forbidden'], what);
  }
  const byMember = await adminOp(member, proj, 'set-hosted-service', { service: 'render', enabled: false }, { password: 'wrong-pw' });
  assert.deepEqual([byMember.type, byMember.reason], ['error', 'forbidden'], '不是创建者');
  const badValue = await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: 'no' });
  assert.deepEqual([badValue.type, badValue.reason], ['error', 'bad-message']);
  assert.equal(env.store.peek(proj.projectId).hosted, undefined, '被拒的操作没有落盘');

  // 服务先认领一个任务
  assert.equal(await outcome(data, { type: 'node.hello', nodeId: 'hosted-render:t/hr11', profile: 'host' }, 'node.welcome'), 'node.welcome');
  await ask(creator, { type: 'publisher.hello', publisherId: 'pub-hr11' }, 'publisher.welcome');
  const task = snapshotTaskInput({ resultKey: `rk-hr11-${Date.now()}`, projectId: PROJECT });
  assert.equal((await ask(creator, { type: 'task.publish', tasks: [task] }, 'task.published')).type, 'task.published');
  const claim = await ask(data, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(claim.type, 'task.claimed', JSON.stringify(claim));
  const taskState = () => env.service.describe().queue?.spaces?.[proj.projectId]?.tasks?.find((x) => x.id === task.id)
    ?? JSON.stringify(env.service.describe()).includes(`"id":"${task.id}","state":"claimed"`);

  // 关
  const off = await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false });
  assert.deepEqual([off.type, off.op], ['shared.admin.ok', 'set-hosted-service']);
  assert.deepEqual(env.store.peek(proj.projectId).hosted, { render: { enabled: false } });
  assert.equal(env.store.peek(proj.projectId).generation, generation, '不加代数');
  assert.deepEqual(await closedWithin(data, 3000, '服务的数据连接'), { code: 4003, reason: 'service-disabled' });
  const notice = await member.next((m) => m.type === 'shared.notice' && m.event === 'hosted-service-changed', 3000);
  assert.deepEqual(notice, { type: 'shared.notice', event: 'hosted-service-changed', service: 'render', enabled: false });
  // 认领立即放回：不用等断线宽限期（10 s），另一个节点马上能认领
  const mine = await join(env, proj, { username: 'rex', role: 'render' });
  assert.equal(await outcome(mine, { type: 'node.hello', nodeId: 'n-hr11', profile: 'pc' }, 'node.welcome'), 'node.welcome');
  const reclaim = await ask(mine, { type: 'task.claim', id: task.id, expectVersion: 3 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(reclaim.type, 'task.claimed', `关掉后任务立即可认领：${JSON.stringify(reclaim)}（${JSON.stringify(taskState())}）`);

  assert.equal(await outcome(member, { type: 'shared.members' }, 'shared.members.list'), 'shared.members.list', '成员连接没断');
  assert.equal(await outcome(control, { type: 'hosted.ticket', projectId: proj.projectId }), 'error:service-disabled', '取不到新票据');
  assert.equal((await env.handshake([PROTOCOL, TICKET_PREFIX + data.ticket])).status, 401, '关掉之前的票据进不来');

  // 再开
  const on = await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: true });
  assert.equal(on.type, 'shared.admin.ok');
  assert.deepEqual(await member.next((m) => m.type === 'shared.notice' && m.event === 'hosted-service-changed', 3000), { type: 'shared.notice', event: 'hosted-service-changed', service: 'render', enabled: true });
  const again = await openData(env, control, proj.projectId);
  assert.equal(await outcome(again, { type: 'queue.watch', projects: 'all' }), 'error:not-registered', '进得来（还没报到，所以是队列自己的 not-registered，不是 forbidden）');
});

test('HR11 接续与逐消息都重新核对开关：记录被直接改掉（不经创建者操作）时，服务连接的下一条消息被拒', async (t) => {
  const { env, proj, data } = await setup(t);
  assert.equal(await outcome(data, { type: 'content.list', kind: 'card-source' }, 'content.listing'), 'content.listing');
  env.store.update(proj.projectId, (d) => { d.hosted = { render: { enabled: false } }; });
  assert.equal(await outcome(data, { type: 'content.list', kind: 'card-source' }), 'error:service-disabled');
  assert.equal(await outcome(data, { type: 'auth.ticket', kind: 'asset' }), 'error:service-disabled');
});

// ------------------------------------------------------------------ HR12

test('HR12 成员列表：服务连接的行带 service、不是创建者；顶层 hosted；认领时带「渲染中」；放本机的项目没有这些', async (t) => {
  const { env, proj, creator, data } = await setup(t);
  const list = await ask(creator, { type: 'shared.members' }, 'shared.members.list');
  assert.deepEqual(list.hosted, { render: { available: true, enabled: true }, agent: { available: false, enabled: true } });
  const row = list.devices.find((d) => d.service === 'render');
  assert.ok(row, JSON.stringify(list.devices));
  assert.deepEqual(
    { username: row.username, displayName: row.displayName, creator: row.creator, deviceId: row.deviceId, deviceName: row.deviceName, conns: row.conns, tags: row.tags },
    { username: 'service:render', displayName: 'service:render', creator: false, deviceId: env.keys.render.instanceId, deviceName: env.keys.render.instanceName,
      conns: [{ role: 'render' }], tags: { editing: false, rendering: false, agents: 0 } },
  );
  const others = list.devices.filter((d) => d !== row);
  assert.ok(others.length === 1 && !('service' in others[0]), '成员的行没有 service 字段');

  // 订阅者在开关变化时收到新的列表
  await ask(creator, { type: 'shared.watch' }, 'shared.members.list');
  await ask(data, { type: 'node.hello', nodeId: 'hosted-render:t/hr12', profile: 'host' }, 'node.welcome');
  await ask(creator, { type: 'publisher.hello', publisherId: 'pub-hr12' }, 'publisher.welcome');
  const task = snapshotTaskInput({ resultKey: `rk-hr12-${Date.now()}`, projectId: PROJECT });
  await ask(creator, { type: 'task.publish', tasks: [task] }, 'task.published');
  assert.equal((await ask(data, { type: 'task.claim', id: task.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected'])).type, 'task.claimed');
  const rendering = await waitFor(async () => (await members(creator)).find((d) => d.service === 'render')?.tags.rendering || null, 3000, '「渲染中」');
  assert.equal(rendering, true);

  await adminOp(creator, proj, 'set-hosted-service', { service: 'render', enabled: false });
  const pushed = await creator.next((m) => m.type === 'shared.members.list' && m.hosted?.render?.enabled === false && !m.devices.some((d) => d.service), 3000);
  assert.deepEqual(pushed.hosted.render, { available: true, enabled: false });

  // 放本机（挂载模式）：没有 hosted，开关操作 bad-message
  const lan = await serviceHostFor(t, { attached: true, trustLoopback: true });
  const r = await lan.http('shared/create', { method: 'POST', body: { name: `hr12-${process.pid}`, mode: 'free', kdf: { alg: 'pbkdf2-sha256', iter: 100_000 }, creator: (await import('./auth-kit.mjs')).credential('creator-pw', 'alice'), project: (await import('./auth-kit.mjs')).credential('project-pw') } });
  assert.equal(r.status, 201, r.text);
  const lanProj = { projectId: r.json.projectId, mode: 'free', creator: { username: 'alice', password: 'creator-pw' }, password: 'project-pw' };
  const host = await join(lan, lanProj, { username: 'alice', as: 'creator', remote: '198.51.100.20' });
  const lanList = await ask(host, { type: 'shared.members' }, 'shared.members.list');
  assert.equal('hosted' in lanList, false);
  const refused = await adminOp(host, lanProj, 'set-hosted-service', { service: 'render', enabled: false });
  assert.deepEqual([refused.type, refused.reason], ['error', 'bad-message']);
});

// ------------------------------------------------------------------ HR13

test('HR13 空间隔离：服务在项目甲的数据连接看不到项目乙的内容与任务；甲的票据进不了乙', async (t) => {
  const env = await serviceHostFor(t);
  const projA = await createProject(env, { mode: 'free' });
  const projB = await createProject(env, { mode: 'free' });
  const a = await join(env, projA, { username: 'ann' });
  const b = await join(env, projB, { username: 'ben' });
  const control = await openControl(env, env.keys.render);
  const dataA = await openData(env, control, projA.projectId);

  // 乙里放内容库条目、项目内容、任务
  assert.equal((await ask(b, { type: 'content.put', kind: 'card-source', key: 'src/cards/user/b.card.tsx', body: { source: 'secret-of-b' } }, 'content.stored')).type, 'content.stored');
  await ask(b, { type: 'project.op', projectId: PROJECT, opId: 'op-b', session: 's-b', ops: [{ op: 'set', path: '', value: { ...projectBody(), name: 'secret-of-b' } }] }, ['project.op.ok']);
  await ask(b, { type: 'publisher.hello', publisherId: 'pub-b' }, 'publisher.welcome');
  const taskB = snapshotTaskInput({ resultKey: `rk-hr13-b-${Date.now()}`, projectId: PROJECT });
  await ask(b, { type: 'task.publish', tasks: [taskB] }, 'task.published');

  // 服务在甲里：订阅、列、开同名项目、认领乙的任务
  await ask(dataA, { type: 'content.watch', kinds: ['card-source'] }, 'content.watching');
  const listing = await ask(dataA, { type: 'content.list', kind: 'card-source' }, 'content.listing');
  assert.deepEqual(listing.items, [], '甲的内容库里没有乙的条目');
  const state = await ask(dataA, { type: 'project.open', projectId: PROJECT }, 'project.state');
  assert.equal(JSON.stringify(state).includes('secret-of-b'), false, '同名的项目文档 id 在两个空间里不串');
  await ask(dataA, { type: 'node.hello', nodeId: 'hosted-render:t/hr13', profile: 'host' }, 'node.welcome');
  await ask(dataA, { type: 'queue.watch', projects: 'all' });
  const claim = await ask(dataA, { type: 'task.claim', id: taskB.id, expectVersion: 1 }, ['task.claimed', 'task.claim-rejected']);
  assert.equal(claim.type, 'task.claim-rejected', `认领乙的任务：${JSON.stringify(claim)}`);
  // 乙里再写一条，甲的连接收不到
  await ask(b, { type: 'content.put', kind: 'card-source', key: 'src/cards/user/b2.card.tsx', body: { source: 'secret-of-b-2' } }, 'content.stored');
  await sleep(200);
  assert.equal(JSON.stringify(dataA.all).includes('secret-of-b'), false, '甲的连接上没有出现过乙的任何内容');
  assert.equal(dataA.all.some((m) => JSON.stringify(m).includes(taskB.id) && m.type !== 'task.claim-rejected'), false, '甲的连接上没有出现过乙的任务');

  // 票据绑定项目：把甲的票据改成乙的项目号，签名不对
  assert.equal((await env.handshake([PROTOCOL, TICKET_PREFIX + tamperTicket(dataA.ticket, { p: projB.projectId })])).status, 401);
  // 服务要进乙，得另要一张乙的票据；成员列表各自只见自己空间里的那一行
  const dataB = await openData(env, control, projB.projectId);
  assert.equal((await members(a)).filter((d) => d.service === 'render').length, 1);
  assert.equal((await members(b)).filter((d) => d.service === 'render').length, 1);
  assert.equal((await ask(dataB, { type: 'content.list', kind: 'card-source' }, 'content.listing')).items.length, 2);
  assert.equal((await requestServiceTicket(control, projA.projectId)).type, 'hosted.ticket.ok');
  void newDevice;
});
