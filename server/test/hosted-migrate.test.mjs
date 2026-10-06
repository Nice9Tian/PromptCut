/**
 * 托管端换机（2026-10-06）：旧项目文件、恢复凭证、本机记录里的阿里云地址读进来换成新节点（`server/auth/hosted-default.mjs`）。
 *   HM-1 字符串：IP 形式与 sslip.io 形式（含舞台子域）换主机名，协议、端口、路径不变；别的主机不动
 *   HM-2 深拷：对象的键（恢复记录的键是带地址的 JSON 串）与值都换；没有旧地址时返回原对象
 *   HM-3 协作描述：旧文件里的 service / hint 解析后是新地址，键与新建的记录一致
 *   HM-4 恢复凭证库：旧地址下记的身份、撤销标记、绑定，换成新地址后照样选得到、照样拦
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_HOSTED_URL, migrateHostedText, migrateHostedDeep } from '../auth/hosted-default.mjs';
import { parseCollaboration, identityKey, roomKey, serviceIdentity } from '../recovery/descriptor.mjs';
import { openRecoveryVault } from '../recovery/vault.mjs';

const OLD = 'http://8.219.80.16:8787';
const ROOM = 'sp_abcdefghijklmnopqrstuvwxyz';

test('HM-1 字符串换主机名', () => {
  assert.equal(DEFAULT_HOSTED_URL, 'http://149.88.94.84:8787');
  assert.equal(migrateHostedText(OLD), DEFAULT_HOSTED_URL);
  assert.equal(migrateHostedText('ws://8.219.80.16:8787/'), 'ws://149.88.94.84:8787/');
  assert.equal(migrateHostedText('http://8.219.80.16:8788/api/asset'), 'http://149.88.94.84:8788/api/asset');
  assert.equal(migrateHostedText('wss://8-219-80-16.sslip.io/hosted/'), 'wss://149-88-94-84.sslip.io/hosted/');
  assert.equal(migrateHostedText('https://s1.8-219-80-16.sslip.io'), 'https://s1.149-88-94-84.sslip.io');
  assert.equal(migrateHostedText('https://8-219-80-16.sslip.io/editor#invite=x'), 'https://149-88-94-84.sslip.io/editor#invite=x');
  // 别的主机、只是前缀相同的主机不动
  for (const keep of ['http://18.219.80.16:8787', 'http://8.219.80.160:8787', 'http://127.0.0.1:8787', 'https://x8-219-80-16.sslip.io', '']) assert.equal(migrateHostedText(keep), keep);
  assert.equal(migrateHostedText(null), null);
});

test('HM-2 深拷：键与值', () => {
  const key = JSON.stringify([OLD, ROOM, 'member', 'u']);
  const v = { [key]: { candidate: { base: 'ws://8.219.80.16:8787', service: OLD, projectId: ROOM }, n: 1 }, keep: ['a', 2] };
  const m = migrateHostedDeep(v);
  assert.deepEqual(Object.keys(m), [JSON.stringify([DEFAULT_HOSTED_URL, ROOM, 'member', 'u']), 'keep']);
  assert.equal(m[Object.keys(m)[0]].candidate.base, 'ws://149.88.94.84:8787');
  assert.equal(v[key].candidate.service, OLD, '原对象不改');
  const plain = { a: { b: ['http://127.0.0.1:1'] } };
  assert.equal(migrateHostedDeep(plain), plain);
});

test('HM-3 旧项目文件的协作描述', () => {
  const d = parseCollaboration({ version: 1, roomId: ROOM, service: 'ws://8.219.80.16:8787/', where: 'lan', hint: 'wss://8-219-80-16.sslip.io/hosted/' });
  assert.equal(d.service, DEFAULT_HOSTED_URL);
  assert.equal(d.hint, 'https://149-88-94-84.sslip.io/hosted');
  assert.equal(serviceIdentity(OLD), serviceIdentity(DEFAULT_HOSTED_URL));
  assert.equal(roomKey({ service: OLD, roomId: ROOM }), roomKey({ service: DEFAULT_HOSTED_URL, roomId: ROOM }));
});

test('HM-4 恢复凭证库里旧地址的记录', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-hosted-migrate-'));
  try {
    const protector = { kind: 'test-plain', seal: (b) => Buffer.from(b), open: (b) => Buffer.from(b) };
    // 按旧版的写法直接写一份：键用旧地址算
    const oldDesc = { service: OLD, roomId: ROOM };
    const record = { service: OLD, roomId: ROOM, as: 'member', username: 'm', key: 'k'.repeat(43), candidate: { where: 'lan', base: 'ws://8.219.80.16:8787', service: OLD, projectId: ROOM } };
    const oldRoom = JSON.stringify([OLD, ROOM]);
    const oldId = JSON.stringify([OLD, ROOM, 'default', 'member', 'm']);
    const otherRoom = 'sp_zyxwvutsrqponmlkjihgfedcba';
    const state = { version: 1, identities: { [oldId]: record }, bindings: { [JSON.stringify([oldRoom, 'content-1'])]: oldId },
      revoked: { [JSON.stringify([OLD, otherRoom])]: 1 }, hosts: {}, journals: {}, settings: {}, unregister: {}, moves: {} };
    const bytes = Buffer.from(JSON.stringify(state));
    fs.writeFileSync(path.join(dir, 'identities.json'), JSON.stringify({ version: 1, protection: protector.kind, digest: createHash('sha256').update(bytes).digest('hex'), payload: bytes.toString('base64') }));
    const vault = openRecoveryVault({ dir, protector });
    const desc = parseCollaboration({ version: 1, roomId: ROOM, service: OLD, where: 'lan' });
    const sel = vault.select(desc, 'content-1');
    assert.equal(sel.identities.length, 1);
    assert.equal(sel.selected?.candidate.base, 'ws://149.88.94.84:8787');
    assert.equal(identityKey(sel.selected), JSON.stringify([DEFAULT_HOSTED_URL, ROOM, 'default', 'member', 'm']));
    assert.equal(vault.select({ ...desc, roomId: otherRoom }, 'c').revoked, true, '旧地址下的撤销标记照样拦');
    void oldDesc;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
