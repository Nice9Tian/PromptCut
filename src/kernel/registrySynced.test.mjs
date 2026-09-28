/**
 * 注册表里「已知但本机不能运行」的用户卡(C10 契约第 9 节「识别」)。跑:
 *   node --test src/kernel/registrySynced.test.mjs
 *
 * 钉的是:同步表不进主注册表(`allCards` / `getCard` 看不到);`isUserCardId` = 构建时的定制卡登记或同步表;
 * 和构建时卡片 id 撞车的同步条目忽略(内置赢);显示名依次取构建时定义 → 同步表 → null;变了才通知。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const R = await import(srcUrl("kernel/registry.ts"));
const def = (id, name) => ({ id, name, defaults: {}, controls: [], Component: () => null });

test("同步表:不进主注册表;isUserCardId 与显示名;撞车的忽略;变了才通知", () => {
  R.resetCards();
  R.registerCards([def("builtin-a", "内置甲"), def("mine", "构建时用户卡")]);
  R.setUserCardSources({ mine: "" }, { mine: "mine" });
  let calls = 0;
  const off = R.onSyncedUserCardsChanged(() => calls++);
  try {
    const gen0 = R.syncedUserCardsGen();
    assert.equal(R.setSyncedUserCards([
      { id: "synced-x", name: "同步甲", source: "src/cards/user/x.tsx" },
      { id: "synced-x", name: "重复的后一条", source: "src/cards/user/x2.tsx" },
      { id: "builtin-a", name: "撞内置", source: "src/cards/user/y.tsx" },
      { id: "mine", name: "撞构建时用户卡", source: "src/cards/user/mine.tsx" },
      { id: "", name: "空 id" },
    ]), true);
    assert.equal(calls, 1);
    assert.equal(R.syncedUserCardsGen(), gen0 + 1);
    // 不进主注册表
    assert.deepEqual(R.allCards().map((c) => c.id).sort(), ["builtin-a", "mine"]);
    assert.equal(R.getCard("synced-x"), undefined);
    // isUserCardId
    assert.equal(R.isUserCardId("synced-x"), true, "同步来的用户卡");
    assert.equal(R.isUserCardId("mine"), true, "构建时的用户卡");
    assert.equal(R.isUserCardId("builtin-a"), false, "和内置卡撞车的同步条目忽略:内置赢");
    assert.equal(R.isUserCardId("nobody"), false, "两边都没有");
    assert.equal(R.isUserCardId(undefined), false);
    assert.equal(R.isUserCardId(""), false);
    // 显示名
    assert.equal(R.knownCardName("synced-x"), "同步甲", "同 id 多条取第一条");
    assert.equal(R.knownCardName("mine"), "构建时用户卡", "构建时定义的名字优先");
    assert.equal(R.knownCardName("builtin-a"), "内置甲");
    assert.equal(R.knownCardName("nobody"), null, "未知卡片");
    // 同一份再设一次:不变、不通知
    assert.equal(R.setSyncedUserCards([{ id: "synced-x", name: "同步甲", source: "src/cards/user/x.tsx" },
      { id: "builtin-a", name: "撞内置", source: "src/cards/user/y.tsx" }, { id: "mine", name: "撞构建时用户卡", source: "src/cards/user/mine.tsx" }]), false);
    assert.equal(calls, 1);
    // 改名:通知
    assert.equal(R.setSyncedUserCards([{ id: "synced-x", name: "改名了", source: "src/cards/user/x.tsx" }]), true);
    assert.equal(calls, 2);
    assert.equal(R.knownCardName("synced-x"), "改名了");
    // 清空
    R.setSyncedUserCards([]);
    assert.equal(R.isUserCardId("synced-x"), false);
    assert.equal(R.knownCardName("synced-x"), null);
    assert.equal(R.syncedUserCards().size, 0);
  } finally {
    off();
    R.setSyncedUserCards([]);
    R.setUserCardSources({}, {});
    R.resetCards();
  }
});
