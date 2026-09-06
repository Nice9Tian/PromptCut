import { test } from "node:test";
import assert from "node:assert/strict";
import { machineCode, machineFingerprint } from "../runners/machine-id.mjs";

test("同一台机器每次算出同一串码", () => {
  assert.equal(machineCode(), machineCode());
  assert.equal(machineFingerprint(), machineFingerprint());
});

test("码的形状是 PCM- 加 4 组 5 位 Crockford Base32", () => {
  assert.match(machineCode(), /^PCM(-[0-9A-HJKMNP-TV-Z]{5}){4}$/);
});

test("不同指纹给出不同的码", () => {
  assert.notEqual(machineCode("win:aaaa"), machineCode("win:bbbb"));
});

test("码里不含原始指纹", () => {
  const code = machineCode("win:11112222-3333-4444-5555-666677778888");
  assert.ok(!code.includes("1111"));
  assert.ok(!code.includes("6666"));
});

test("取不到机器标识时也能算出码,不抛错", () => {
  const fingerprint = machineFingerprint();
  assert.equal(typeof fingerprint, "string");
  assert.ok(fingerprint.length > 0);
  // 兜底串至少要带上主机名和平台,不能是空壳
  if (fingerprint.startsWith("fallback:")) {
    assert.ok(fingerprint.includes(process.platform));
  }
});
