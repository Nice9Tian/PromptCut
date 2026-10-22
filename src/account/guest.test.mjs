/**
 * 游客身份（`guest.ts`）：编号的形状、头像的稳定与分布、在本机记住与「换一个」。
 *
 * 头像那几条测的是「同一个 ID 每次画出来都一样」——界面上一旦不稳定，
 * 同一个人每次重渲染都换张脸，成员列表就认不出谁是谁了。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GUEST_ID_RE, GUEST_SHAPES, GUEST_STORAGE_KEY,
  GUEST_LIMITS, GUEST_LIMITS_TEXT,
  adoptGuestSession, clearGuest, ensureGuest, forgetGuestProject, rememberGuestProject, guestAvatar, guestFrom, guestName, isGuestId, loadGuest, newGuestId, resetGuest,
} from './guest.ts';
import { GUEST_LIMITS as SERVER_LIMITS } from '../../server/account/guest.mjs';

/** 假的 localStorage。`throwOn` 里点名的方法一调就抛，用来演无痕窗口 */
function fakeStore(throwOn = []) {
  const map = new Map();
  const guard = name => { if (throwOn.includes(name)) throw new Error('SecurityError'); };
  return {
    map,
    getItem(k) { guard('getItem'); return map.has(k) ? map.get(k) : null; },
    setItem(k, v) { guard('setItem'); map.set(k, String(v)); },
    removeItem(k) { guard('removeItem'); map.delete(k); },
  };
}

test('游客编号是 gst_ 加 24 位十六进制，每次不一样', () => {
  const ids = new Set();
  for (let i = 0; i < 200; i++) {
    const id = newGuestId();
    assert.match(id, GUEST_ID_RE, `${id} 不是游客编号的样子`);
    assert.ok(isGuestId(id));
    ids.add(id);
  }
  assert.equal(ids.size, 200, '200 个里有重复的');
  assert.equal(isGuestId('acc_' + 'a'.repeat(24)), false, '账号编号不能被当成游客编号');
  assert.equal(isGuestId('gst_' + 'A'.repeat(24)), false, '大写十六进制不收');
  assert.equal(isGuestId(''), false);
  assert.equal(isGuestId(null), false);
});

test('显示名取编号末四位，大写，和编号对得上', () => {
  assert.equal(guestName('gst_0123456789abcdef01237f3a'), '游客-7F3A');
  const id = newGuestId();
  assert.equal(guestName(id), `游客-${id.slice(-4).toUpperCase()}`);
  assert.equal(guestFrom(id, 5).name, guestName(id));
  assert.equal(guestFrom(id, 5).createdAt, 5);
});

test('头像由编号定死：同一个编号每次都一样，色相和图形都在范围内', () => {
  for (let i = 0; i < 500; i++) {
    const id = newGuestId();
    const a = guestAvatar(id), b = guestAvatar(id);
    assert.deepEqual(a, b, '同一个编号两次算出来不一样');
    assert.ok(Number.isInteger(a.hue) && a.hue >= 0 && a.hue < 360, `色相越界：${a.hue}`);
    assert.ok(Number.isInteger(a.shape) && a.shape >= 0 && a.shape < GUEST_SHAPES.length, `图形越界：${a.shape}`);
    assert.equal(typeof GUEST_SHAPES[a.shape], 'string');
  }
});

test('头像散得开：一千个编号把十二种图形都用上了，色相也不扎堆', () => {
  const shapes = new Set(), hues = new Set();
  for (let i = 0; i < 1000; i++) {
    const { hue, shape } = guestAvatar(newGuestId());
    shapes.add(shape); hues.add(Math.floor(hue / 30)); // 色相分成 12 格看
  }
  assert.equal(shapes.size, GUEST_SHAPES.length, `一千个只用到 ${shapes.size} 种图形`);
  assert.equal(hues.size, 12, `一千个只落在 ${hues.size} 个色相格里`);
});

test('在本机记住：第一次随机分，之后每次都是同一个', () => {
  const s = fakeStore();
  const first = ensureGuest(s, () => 1000);
  assert.match(first.id, GUEST_ID_RE);
  assert.equal(first.createdAt, 1000);
  for (let i = 0; i < 5; i++) assert.deepEqual(ensureGuest(s, () => 9999), first, '第二次该读回同一个');
  assert.deepEqual(loadGuest(s), first);
  assert.equal(JSON.parse(s.map.get(GUEST_STORAGE_KEY)).id, first.id);
});

test('「换一个」给新的并覆盖存档；清掉之后又回到没有', () => {
  const s = fakeStore();
  const first = ensureGuest(s, () => 1);
  const second = resetGuest(s, () => 2);
  assert.notEqual(second.id, first.id);
  assert.equal(second.createdAt, 2);
  assert.deepEqual(loadGuest(s), second, '存档该是新的那个');
  clearGuest(s);
  assert.equal(loadGuest(s), null);
  assert.equal(s.map.has(GUEST_STORAGE_KEY), false);
});

test('存档坏了当没有，不抛：不是 JSON、编号不合法、名字被人改过', () => {
  const s = fakeStore();
  for (const bad of ['', '不是 JSON', '{}', '{"id":123}', '{"id":"acc_' + 'a'.repeat(24) + '"}', 'null', '[]']) {
    s.map.set(GUEST_STORAGE_KEY, bad);
    assert.equal(loadGuest(s), null, `坏存档没当成没有：${bad}`);
  }
  // 编号合法但名字被改过:名字按编号重算,不信存下来的那一份
  const id = newGuestId();
  s.map.set(GUEST_STORAGE_KEY, JSON.stringify({ id, name: '管理员', createdAt: 7 }));
  assert.deepEqual(loadGuest(s), { id, name: guestName(id), createdAt: 7 });
});

test('localStorage 读写一抛就当没记住，照样给得出身份（无痕窗口）', () => {
  const noWrite = fakeStore(['setItem']);
  const a = ensureGuest(noWrite, () => 1);
  assert.match(a.id, GUEST_ID_RE, '存不下也得有身份');
  assert.equal(noWrite.map.size, 0);
  const noRead = fakeStore(['getItem']);
  assert.equal(loadGuest(noRead), null);
  assert.match(ensureGuest(noRead, () => 1).id, GUEST_ID_RE);
  assert.doesNotThrow(() => clearGuest(fakeStore(['removeItem'])));
  // 完全没有 localStorage(Node 里跑、或者站点数据被禁):给 null 走兜底那一条
  assert.equal(loadGuest(null), null);
  assert.match(ensureGuest(null, () => 1).id, GUEST_ID_RE);
});

test('认下服务端给的身份：编号以它为准，令牌一起存；同一个编号回来不改生日', () => {
  const s = fakeStore();
  const local = ensureGuest(s, () => 1);            // 还没进过云端时的临时身份
  const fromServer = { id: newGuestId(), token: 'tok-1', expiresAt: 99_000 };

  const adopted = adoptGuestSession(fromServer, s, () => 2);
  assert.equal(adopted.id, fromServer.id, '云端的编号由服务端说了算');
  assert.notEqual(adopted.id, local.id);
  assert.equal(adopted.createdAt, 2, '换了个编号就是换了个人，生日重记');
  assert.equal(adopted.token, 'tok-1');
  assert.deepEqual(loadGuest(s), adopted, '令牌也该一起存下来，下次进来好续期');

  // 同一个编号续期:只换令牌,生日不动
  const renewed = adoptGuestSession({ ...fromServer, token: 'tok-2', expiresAt: 190_000 }, s, () => 500);
  assert.equal(renewed.createdAt, 2);
  assert.equal(renewed.token, 'tok-2');
  assert.equal(loadGuest(s)?.expiresAt, 190_000);

  assert.throws(() => adoptGuestSession({ id: 'acc_' + 'a'.repeat(24), token: 't', expiresAt: 1 }, s), /不是游客编号/);
});

test('存档里令牌坏了只丢令牌，编号还认：人还是那个人，续期时当没带', () => {
  const s = fakeStore();
  const id = newGuestId();
  s.map.set(GUEST_STORAGE_KEY, JSON.stringify({ id, createdAt: 3, token: 42, expiresAt: 'soon' }));
  const got = loadGuest(s);
  assert.equal(got?.id, id);
  assert.equal(got?.token, undefined);
  assert.equal(got?.expiresAt, undefined);
});

test('界面上说的限额和服务端真正拦的那几个数对得上', () => {
  // 两边各写一份是为了「进来之前先讲清楚」,但数一旦对不上,界面就在骗人。说了算的永远是服务端
  assert.equal(GUEST_LIMITS.projects, SERVER_LIMITS.projects);
  assert.equal(GUEST_LIMITS.videos, SERVER_LIMITS.videos);
  assert.equal(GUEST_LIMITS.assetMB * 1024 * 1024, SERVER_LIMITS.assetBytes);
  assert.equal(GUEST_LIMITS.ttlDays * 24 * 60 * 60 * 1000, SERVER_LIMITS.ttlMs);
  // 那句话里的数也是从上面这几个拼出来的,不是手写死的
  for (const n of [GUEST_LIMITS.projects, GUEST_LIMITS.videos, GUEST_LIMITS.assetMB, GUEST_LIMITS.ttlDays])
    assert.ok(GUEST_LIMITS_TEXT.includes(String(n)), `那句话里该出现 ${n}`);
  // 用户 2026-10-23 的口径：数的是视频、每一条源文件限尺寸。界面那句话不能再说成「几条素材」
  assert.match(GUEST_LIMITS_TEXT, new RegExp(`${GUEST_LIMITS.videos} 条视频`));
  assert.match(GUEST_LIMITS_TEXT, /每条源文件/);
  assert.doesNotMatch(GUEST_LIMITS_TEXT, /条素材/);
  assert.equal(SERVER_LIMITS.assets, undefined, '服务端不该还留着按素材条数数的旧名字');
});

test('记住游客自己那一个项目：换身份不带过去，清掉之后不再挂着', () => {
  const s = fakeStore();
  assert.equal(rememberGuestProject({ id: 'sp_1', name: '第一个' }, s), null, '还没有身份时记不下，也不该抛');

  const me = ensureGuest(s, () => 1);
  const withProject = rememberGuestProject({ id: 'sp_1', name: '第一个' }, s);
  assert.deepEqual(withProject.project, { id: 'sp_1', name: '第一个' });
  assert.deepEqual(loadGuest(s)?.project, { id: 'sp_1', name: '第一个' }, '该存回本机，刷新之后还找得到');
  assert.equal(loadGuest(s)?.id, me.id);

  // 同一个人续期:项目跟着留
  adoptGuestSession({ id: me.id, token: 'tok', expiresAt: 9_000 }, s, () => 2);
  assert.deepEqual(loadGuest(s)?.project, { id: 'sp_1', name: '第一个' });

  // 换了个人:上一个人的项目不归他
  adoptGuestSession({ id: newGuestId(), token: 'tok2', expiresAt: 9_000 }, s, () => 3);
  assert.equal(loadGuest(s)?.project, undefined);

  // 项目没了就划掉
  rememberGuestProject({ id: 'sp_2', name: '第二个' }, s);
  assert.equal(forgetGuestProject(s)?.project, undefined);
  assert.equal(loadGuest(s)?.project, undefined);
  assert.ok(loadGuest(s)?.id, '划掉项目不该把身份一起弄丢');

  // 存档里的项目写坏了当没有
  const id = newGuestId();
  s.map.set(GUEST_STORAGE_KEY, JSON.stringify({ id, createdAt: 1, project: { id: 5 } }));
  assert.equal(loadGuest(s)?.project, undefined);
});
