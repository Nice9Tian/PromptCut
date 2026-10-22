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
  clearGuest, ensureGuest, guestAvatar, guestFrom, guestName, isGuestId, loadGuest, newGuestId, resetGuest,
} from './guest.ts';

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
