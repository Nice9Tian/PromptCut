/**
 * 低内存档判定(`docs/plan/c10a-contract.md` 第 8 节):注入 `deviceMemory`、屏幕尺寸、触点数、media query 的桩。
 */
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  judgeLowMemory, probeDevice, lowMemoryMode, noteRuntimeTrouble, setDisplayTier, readDisplayTier, resetLowMemoryForTest,
  downgradedThisSession, onLowMemoryChange, LOW_MEMORY_TEXT, TO_NORMAL_NOTICE, NEXT_LOAD_NOTICE, DISPLAY_TIER_KEY, SESSION_DOWNGRADE_KEY,
} from './lowMemory.ts';

const desktop = { deviceMemory: 8, coarsePointer: false, maxTouchPoints: 0, screenWidth: 2560, screenHeight: 1440 };
const phone = { deviceMemory: undefined, coarsePointer: true, maxTouchPoints: 5, screenWidth: 390, screenHeight: 844 };
const ipad = { deviceMemory: undefined, coarsePointer: true, maxTouchPoints: 5, screenWidth: 1024, screenHeight: 1366 };
const bigTouch = { deviceMemory: 8, coarsePointer: true, maxTouchPoints: 10, screenWidth: 2560, screenHeight: 1600 };

function kv() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

beforeEach(() => resetLowMemoryForTest());

test('LM1 deviceMemory ≤ 4 判低内存;8 不判', () => {
  assert.equal(judgeLowMemory({ ...desktop, deviceMemory: 4 }), true);
  assert.equal(judgeLowMemory({ ...desktop, deviceMemory: 2 }), true);
  assert.equal(judgeLowMemory({ ...desktop, deviceMemory: 8 }), false);
  assert.equal(judgeLowMemory(desktop), false);
});

test('LM2 触屏 + 触点 ≥ 2 + 长边 ≤ 1600 判低内存(iOS 没有 deviceMemory 也判得出)', () => {
  assert.equal(judgeLowMemory(phone), true);
  assert.equal(judgeLowMemory(ipad), true, 'iPad 长边 1366');
  assert.equal(judgeLowMemory({ ...ipad, screenHeight: 1600 }), true, '长边正好 1600');
  assert.equal(judgeLowMemory({ ...ipad, screenHeight: 1601 }), false, '长边 1601');
  assert.equal(judgeLowMemory({ ...phone, maxTouchPoints: 1 }), false, '触点 1');
  assert.equal(judgeLowMemory({ ...phone, coarsePointer: false }), false, '不是粗指针');
  assert.equal(judgeLowMemory(bigTouch), false, '大屏触屏电脑');
});

test('LM3 覆盖值:low / normal 直接照它,auto 按规则', () => {
  assert.equal(judgeLowMemory(desktop, 'low'), true);
  assert.equal(judgeLowMemory(phone, 'normal'), false);
  assert.equal(judgeLowMemory(phone, 'auto'), true);
});

test('LM4 probeDevice 读 matchMedia 的 pointer 与 any-pointer,不看 UA', () => {
  const env = (queries) => ({
    navigator: { deviceMemory: 4, maxTouchPoints: 5, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' },
    matchMedia: (q) => ({ matches: queries.includes(q) }),
    screen: { width: 820, height: 1180 },
  });
  const a = probeDevice(env(['(pointer: coarse)']));
  assert.deepEqual(a, { deviceMemory: 4, coarsePointer: true, maxTouchPoints: 5, screenWidth: 820, screenHeight: 1180 });
  assert.equal(probeDevice(env(['(any-pointer: coarse)'])).coarsePointer, true);
  assert.equal(probeDevice(env([])).coarsePointer, false);
  // matchMedia 抛错、没有 screen:当作不像手机
  const bare = probeDevice({ navigator: {}, matchMedia: () => { throw new Error('x'); } });
  assert.deepEqual(bare, { deviceMemory: undefined, coarsePointer: false, maxTouchPoints: 0, screenWidth: 0, screenHeight: 0 });
  assert.equal(judgeLowMemory(bare), false);
});

test('LM5 桌面运行环境恒为普通档(online = false),哪怕设备像手机', () => {
  assert.equal(lowMemoryMode(false, { probe: phone, override: 'low', session: kv() }), false);
});

test('LM6 在线模式载入时判一次;设备设置改了下次载入才生效', () => {
  const store = kv();
  assert.equal(lowMemoryMode(true, { probe: phone, override: readDisplayTier(store), session: kv() }), true);
  const r = setDisplayTier('normal', true, phone, store);
  assert.equal(store.m.get(DISPLAY_TIER_KEY), 'normal');
  assert.equal(r.notice, TO_NORMAL_NOTICE, '从低内存切到普通要提示');
  assert.equal(lowMemoryMode(true, { probe: phone, override: readDisplayTier(store) }), true, '本次会话不变');
  resetLowMemoryForTest();
  assert.equal(lowMemoryMode(true, { probe: phone, override: readDisplayTier(store), session: kv() }), false, '下次载入生效');
  assert.equal(setDisplayTier('auto', false, phone, store).notice, NEXT_LOAD_NOTICE);
  assert.equal(store.m.has(DISPLAY_TIER_KEY), false, 'auto 不留键');
});

test('LM7 运行中 webglcontextlost 一次即改判并提示一次;之后刷新同一会话仍是低内存档', () => {
  const sess = kv();
  assert.equal(lowMemoryMode(true, { probe: desktop, override: 'auto', session: sess }), false);
  const seen = [];
  onLowMemoryChange((low) => seen.push(low));
  const r = noteRuntimeTrouble('webglcontextlost', true, sess);
  assert.deepEqual(r, { downgradedNow: true, notice: LOW_MEMORY_TEXT.downgraded });
  assert.equal(r.notice, '这台设备内存吃紧，已改用低内存档。');
  assert.deepEqual(seen, [true]);
  assert.equal(lowMemoryMode(true), true);
  assert.equal(downgradedThisSession(), true);
  assert.deepEqual(noteRuntimeTrouble('webglcontextlost', true, sess), { downgradedNow: false, notice: null }, '只提示一次');
  assert.equal(sess.m.get(SESSION_DOWNGRADE_KEY), '1');
  resetLowMemoryForTest();
  assert.equal(lowMemoryMode(true, { probe: desktop, override: 'auto', session: sess }), true, '同一会话刷新仍按低内存档');
});

test('LM8 连续 3 次解码失败才改判;中间一次成功就清零', () => {
  const sess = kv();
  lowMemoryMode(true, { probe: desktop, override: 'auto', session: sess });
  assert.equal(noteRuntimeTrouble('decode-failure', true, sess).downgradedNow, false);
  assert.equal(noteRuntimeTrouble('decode-failure', true, sess).downgradedNow, false);
  noteRuntimeTrouble('decode-ok', true, sess);
  assert.equal(noteRuntimeTrouble('decode-failure', true, sess).downgradedNow, false);
  assert.equal(noteRuntimeTrouble('decode-failure', true, sess).downgradedNow, false);
  assert.equal(lowMemoryMode(true), false);
  const r = noteRuntimeTrouble('decode-failure', true, sess);
  assert.equal(r.downgradedNow, true);
  assert.equal(lowMemoryMode(true), true);
});

test('LM9 桌面运行环境不因运行中出事改判', () => {
  assert.deepEqual(noteRuntimeTrouble('webglcontextlost', false, kv()), { downgradedNow: false, notice: null });
  assert.equal(lowMemoryMode(false), false);
});

test('LM10 进入项目的提示照抄表 C', () => {
  assert.equal(LOW_MEMORY_TEXT.enter, '当前是低内存档：播放时只看预渲染小尺寸和素材小尺寸；停下时再把这一帧画精确，可能要等几秒；这台设备不做预渲染、也不当渲染节点，修改后由渲染节点重渲。');
});
