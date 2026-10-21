/**
 * 托管端换下来的地址（`server/auth/hosted-default.mjs`）：旧项目文件、恢复凭证、本机记录里的地址读进来换成现在的。
 * 2026-10-06 阿里云换到新云节点；2026-10-22 缺省地址从新云节点的 IP 换成自有域名 hosted.visuhive.com。
 *   HM-1 字符串（阿里云的写法）：直连端口 8787 / 8788 换成新域名下的 /hosted、/media（协议换成 https / wss），
 *        sslip.io 名字换主机名、路径不变，s1. / s2. 舞台子域换成 s1. / s2.visuhive.com；别的主机不动
 *   HM-2 深拷：对象的键（恢复记录的键是带地址的 JSON 串）与值都换；没有旧地址时返回原对象
 *   HM-3 协作描述：旧文件里的 service / hint 解析后是新地址，键与新建的记录一致
 *   HM-4 恢复凭证库：旧地址下记的身份、撤销标记、绑定，换成新地址后照样选得到、照样拦
 *   HM-5 新云节点的 IP 与 sslip.io 写法（0.7.18 及更早的缺省地址）同样换；换过的再换一次不变
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

test('HM-1 字符串换成现在的地址', () => {
  assert.equal(DEFAULT_HOSTED_URL, 'https://hosted.visuhive.com/hosted');
  assert.equal(migrateHostedText(OLD), DEFAULT_HOSTED_URL);
  assert.equal(migrateHostedText('ws://8.219.80.16:8787/'), 'wss://hosted.visuhive.com/hosted/');
  assert.equal(migrateHostedText('http://8.219.80.16:8788/api/asset'), 'https://hosted.visuhive.com/media/api/asset');
  assert.equal(migrateHostedText('wss://8-219-80-16.sslip.io/hosted/'), 'wss://hosted.visuhive.com/hosted/');
  assert.equal(migrateHostedText('https://s1.8-219-80-16.sslip.io'), 'https://s1.visuhive.com');
  assert.equal(migrateHostedText('https://8-219-80-16.sslip.io/editor#invite=x'), 'https://hosted.visuhive.com/editor#invite=x');
  // 别的主机、只是前缀相同的主机不动
  for (const keep of ['http://18.219.80.16:8787', 'http://8.219.80.160:8787', 'http://127.0.0.1:8787', 'https://x8-219-80-16.sslip.io', '']) assert.equal(migrateHostedText(keep), keep);
  assert.equal(migrateHostedText(null), null);
});

test('HM-2 深拷：键与值', () => {
  const key = JSON.stringify([OLD, ROOM, 'member', 'u']);
  const v = { [key]: { candidate: { base: 'ws://8.219.80.16:8787', service: OLD, projectId: ROOM }, n: 1 }, keep: ['a', 2] };
  const m = migrateHostedDeep(v);
  assert.deepEqual(Object.keys(m), [JSON.stringify([DEFAULT_HOSTED_URL, ROOM, 'member', 'u']), 'keep']);
  assert.equal(m[Object.keys(m)[0]].candidate.base, 'wss://hosted.visuhive.com/hosted');
  assert.equal(v[key].candidate.service, OLD, '原对象不改');
  const plain = { a: { b: ['http://127.0.0.1:1'] } };
  assert.equal(migrateHostedDeep(plain), plain);
});

test('HM-3 旧项目文件的协作描述', () => {
  const d = parseCollaboration({ version: 1, roomId: ROOM, service: 'ws://8.219.80.16:8787/', where: 'lan', hint: 'wss://8-219-80-16.sslip.io/hosted/' });
  assert.equal(d.service, DEFAULT_HOSTED_URL);
  assert.equal(d.hint, DEFAULT_HOSTED_URL, 'sslip.io 名字下的 /hosted 与直连端口 8787 现在是同一个地址');
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
    assert.equal(sel.selected?.candidate.base, 'wss://hosted.visuhive.com/hosted');
    assert.equal(identityKey(sel.selected), JSON.stringify([DEFAULT_HOSTED_URL, ROOM, 'default', 'member', 'm']));
    assert.equal(vault.select({ ...desc, roomId: otherRoom }, 'c').revoked, true, '旧地址下的撤销标记照样拦');
    void oldDesc;
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('HM-5 新云节点的 IP 与 sslip.io 写法换成自有域名；换过的不再变', () => {
  const NODE = 'http://149.88.94.84:8787';
  assert.equal(migrateHostedText(NODE), DEFAULT_HOSTED_URL);
  assert.equal(migrateHostedText(`${NODE}/`), 'https://hosted.visuhive.com/hosted/');
  assert.equal(migrateHostedText('ws://149.88.94.84:8787/x?y=1'), 'wss://hosted.visuhive.com/hosted/x?y=1');
  assert.equal(migrateHostedText('http://149.88.94.84:8788/api/asset'), 'https://hosted.visuhive.com/media/api/asset');
  assert.equal(migrateHostedText('https://149-88-94-84.sslip.io/hosted'), DEFAULT_HOSTED_URL);
  assert.equal(migrateHostedText('wss://149-88-94-84.sslip.io/hosted/'), 'wss://hosted.visuhive.com/hosted/');
  assert.equal(migrateHostedText('https://149-88-94-84.sslip.io/media/api/asset'), 'https://hosted.visuhive.com/media/api/asset');
  assert.equal(migrateHostedText('https://s1.149-88-94-84.sslip.io'), 'https://s1.visuhive.com');
  assert.equal(migrateHostedText('https://s2.149-88-94-84.sslip.io/editor/stage.html'), 'https://s2.visuhive.com/editor/stage.html');
  // 不是那两个直连端口的：只换主机名，端口照旧
  assert.equal(migrateHostedText('http://149.88.94.84:5210/x'), 'http://hosted.visuhive.com:5210/x');
  // 夹在 JSON 里（恢复记录的键）也换
  assert.equal(migrateHostedText(JSON.stringify([NODE, ROOM])), JSON.stringify([DEFAULT_HOSTED_URL, ROOM]));
  // 只是前缀或后缀相同的主机不动
  for (const keep of ['http://149.88.94.840:8787', 'http://1149.88.94.84:8787', 'https://x149-88-94-84.sslip.io']) assert.equal(migrateHostedText(keep), keep);
  // 端口只是以 8787 开头的不算直连端口：只换主机名
  assert.equal(migrateHostedText('http://149.88.94.84:87870'), 'http://hosted.visuhive.com:87870');
  assert.equal(serviceIdentity(NODE), serviceIdentity(DEFAULT_HOSTED_URL));
  assert.equal(roomKey({ service: NODE, roomId: ROOM }), roomKey({ service: DEFAULT_HOSTED_URL, roomId: ROOM }));
  for (const v of [DEFAULT_HOSTED_URL, 'https://visuhive.com/hosted', 'https://s1.visuhive.com', 'wss://hosted.visuhive.com/hosted/']) assert.equal(migrateHostedText(v), v);
});
