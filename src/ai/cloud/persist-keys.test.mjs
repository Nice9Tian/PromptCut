/**
 * 云端对话在本地存储里的键(persistKeys.ts)：账号模式按账号编号分，不随页面里的绑定版本变；刷新页面后回到上次的对话。
 * 跑:npm test -- src/ai/cloud/persist-keys.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { chatKey, freshKey, legacyCloudChatId, persistScopeOf, titlesKey } from "./persistKeys.ts";

function memoryStorage(init = {}) {
  const map = new Map(Object.entries(init));
  return { get length() { return map.size; }, key: (i) => [...map.keys()][i] ?? null, getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => map.set(k, String(v)) };
}

test("账号模式的键只看账号编号：同一账号刷新页面前后（绑定版本不同）拿到同一个键", () => {
  const scope = persistScopeOf(true, "acc_0123456789abcdef01234567");
  assert.equal(scope, "acc_0123456789abcdef01234567");
  assert.equal(chatKey("sp_p", "main", scope), "pc.cloudChat:acc_0123456789abcdef01234567:sp_p:main");
  assert.equal(freshKey("sp_p", "main", scope), "pc.cloudFresh:acc_0123456789abcdef01234567:sp_p:main");
  assert.equal(titlesKey("sp_p", scope), "pc.cloudTitles:acc_0123456789abcdef01234567:sp_p");
  assert.equal(persistScopeOf(true, null), "none");
  assert.equal(persistScopeOf(false, "acc_x"), "", "旧通道不分账号");
  assert.equal(chatKey("sp_p", "main", ""), "pc.cloudChat:sp_p:main");
});

test("旧版本按「账号:绑定版本」记的上次对话：只认同一账号、同一项目、同一页，取绑定版本最大的", () => {
  const acc = "acc_0123456789abcdef01234567";
  const storage = memoryStorage({
    [`pc.cloudChat:${acc}:2:sp_p:main`]: "cc-old",
    [`pc.cloudChat:${acc}:7:sp_p:main`]: "cc-latest",
    [`pc.cloudChat:${acc}:9:sp_other:main`]: "cc-other-project",
    [`pc.cloudChat:${acc}:9:sp_p:t2`]: "cc-other-tab",
    [`pc.cloudChat:acc_ffffffffffffffffffffffff:9:sp_p:main`]: "cc-other-account",
    [`pc.cloudChat:${acc}:x:sp_p:main`]: "cc-not-a-version",
  });
  assert.equal(legacyCloudChatId(storage, "sp_p", "main", acc), "cc-latest");
  assert.equal(legacyCloudChatId(storage, "sp_none", "main", acc), null);
  assert.equal(legacyCloudChatId(null, "sp_p", "main", acc), null);
});
