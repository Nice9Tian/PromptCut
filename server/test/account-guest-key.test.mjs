/**
 * 游客令牌的签名密钥（`server/account/guest-key.mjs`）：第一次生成、之后读同一把，
 * 读不了写不了就回 null（游客这条路关掉，不是换一把把老游客全踢下线）。
 *
 * 跑：npm test -- server/test/account-guest-key.test.mjs
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GUEST_KEY_FILE, openGuestKey } from '../account/guest-key.mjs';

const tmp = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-guest-key-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};
const keyPath = dir => path.join(dir, 'secrets', GUEST_KEY_FILE);

test('第一次生成一把存下来，之后每次读同一把', t => {
  const dir = tmp(t);
  const first = openGuestKey(dir);
  assert.equal(first?.length, 32);
  assert.ok(fs.existsSync(keyPath(dir)), '该落盘，不然重启就把游客全踢下线');
  for (let i = 0; i < 3; i++) assert.deepEqual(openGuestKey(dir), first, '每次都该是同一把');
});

test('存坏了不自己改写：报出来、回 null，让人去看', t => {
  const dir = tmp(t);
  openGuestKey(dir);
  fs.writeFileSync(keyPath(dir), 'too-short');
  const seen = [];
  assert.equal(openGuestKey(dir, e => seen.push(e.code)), null, '改写等于换一把，会把在手的令牌全作废');
  assert.deepEqual(seen, ['guest-key-malformed']);
  assert.equal(fs.readFileSync(keyPath(dir), 'utf8'), 'too-short', '原文该原样留着');
});

test('没有数据目录就回 null，游客这条路关掉', t => {
  assert.equal(openGuestKey(''), null);
  assert.equal(openGuestKey(null), null);
  // 目录位置被一个文件占着:写不进去,报出来
  const dir = tmp(t);
  fs.writeFileSync(path.join(dir, 'secrets'), 'not a directory');
  const seen = [];
  assert.equal(openGuestKey(dir, e => seen.push(e.code)), null);
  assert.equal(seen.length, 1, `该报一条，实际 ${JSON.stringify(seen)}`);
});
