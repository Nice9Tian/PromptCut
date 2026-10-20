/**
 * 在线浏览器身份「电脑 / 手机」与界面选择(`src/online/deviceKind.ts`;语义 `mechanism/platforms.md`「身份」)。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { judgeDeviceKind, resolveIpad, pickLayout } from './deviceKind.ts';

const UA = {
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
  desktopChrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  iphoneSafari: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  ipadSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
  macSafari: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15',
};

test('DK1 安卓 Chrome:userAgentData.mobile=true → 手机', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.androidChrome, uaData: { mobile: true }, maxTouchPoints: 5 }), { kind: 'phone', by: 'uaData', ipadLike: false });
});

test('DK2 桌面 Chrome:userAgentData.mobile=false → 电脑', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.desktopChrome, uaData: { mobile: false }, maxTouchPoints: 0 }), { kind: 'desktop', by: 'uaData', ipadLike: false });
});

test('DK3 iPhone Safari:没有 userAgentData,标识里有 iPhone → 手机', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.iphoneSafari, uaData: null, maxTouchPoints: 5 }), { kind: 'phone', by: 'ua', ipadLike: false });
});

test('DK4 iPad Safari(桌面声明 + 多点触控)→ 电脑,标 ipadLike;Mac Safari 不标', () => {
  assert.deepEqual(judgeDeviceKind({ ua: UA.ipadSafari, uaData: null, maxTouchPoints: 5 }), { kind: 'desktop', by: 'ua', ipadLike: true });
  assert.deepEqual(judgeDeviceKind({ ua: UA.macSafari, uaData: null, maxTouchPoints: 0 }), { kind: 'desktop', by: 'ua', ipadLike: false });
});

test('DK5 两样都读不到 → 电脑', () => {
  assert.deepEqual(judgeDeviceKind({}), { kind: 'desktop', by: 'none', ipadLike: false });
  assert.deepEqual(judgeDeviceKind({ ua: '', uaData: {} }), { kind: 'desktop', by: 'none', ipadLike: false });
});

test('DK6 iPad 的舞台闸门接口:没级别不变;第一级算手机,第二、三级算电脑', () => {
  const ipad = judgeDeviceKind({ ua: UA.ipadSafari, maxTouchPoints: 5 });
  assert.equal(resolveIpad(ipad), 'desktop');
  assert.equal(resolveIpad(ipad, 1), 'phone');
  assert.equal(resolveIpad(ipad, 2), 'desktop');
  assert.equal(resolveIpad(ipad, 3), 'desktop');
  const phone = judgeDeviceKind({ ua: UA.androidChrome, uaData: { mobile: true } });
  assert.equal(resolveIpad(phone, 3), 'phone');
});

test('DK7 选界面:在线 + 手机 → 手机版;桌面版恒为桌面界面;?layout= 强制', () => {
  assert.equal(pickLayout({ online: true, kind: 'phone', search: '' }), 'mobile');
  assert.equal(pickLayout({ online: true, kind: 'desktop', search: '' }), 'desktop');
  assert.equal(pickLayout({ online: false, kind: 'phone', search: '' }), 'desktop');
  assert.equal(pickLayout({ online: true, kind: 'desktop', search: '?layout=mobile' }), 'mobile');
  assert.equal(pickLayout({ online: true, kind: 'phone', search: '?layout=desktop' }), 'desktop');
  assert.equal(pickLayout({ online: true, kind: 'phone', search: '?layout=bogus' }), 'mobile');
  assert.equal(pickLayout({ online: false, kind: 'desktop', search: '?layout=mobile' }), 'desktop', '桌面版不认强制参数');
});
