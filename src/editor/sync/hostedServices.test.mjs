/**
 * HR24：项目设置里「托管方的渲染节点」的勾选与成员列表里的服务行（契约 `docs/plan/hosted-render-contract.md` 第 1.7、3、10.1 节）。
 *
 *   node --test src/editor/sync/hostedServices.test.mjs
 *
 *   HR24a 纯逻辑：成员列表顶层 `hosted` 的解析；显示条件（放云端且 `available`）；`hosted-service-changed` 落到状态上；
 *         成员列表拆成成员与服务行（服务行在后、不计数）
 *   HR24b 组件：放本机、没有 `hosted` 字段、`available` 为假时没有这一项；放云端且 `available` 时出现，缺省勾上；
 *         创建者能改（勾选没有 disabled）、其他成员只读（disabled，另有「只有创建者能改」）；点勾选把「要改成什么」交给上层
 *   同步管理（`syncManager.ts`）把成员列表的 `hosted` 与 `hosted-service-changed` 通知接到上面两个纯函数；它在 Node 里载不起来（要浏览器环境），
 *   那一段在浏览器里验（报告里的两张截图与断言）。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const H = await import(srcUrl("editor/sync/hostedServices.ts"));

const ON = { render: { available: true, enabled: true }, agent: { available: false, enabled: true } };
const OFF = { render: { available: true, enabled: false } };

test("HR24a 解析 hosted:形状对才收;没有这个字段(放本机、旧托管端)是 null", () => {
  assert.equal(H.parseHosted(undefined), null);
  assert.equal(H.parseHosted(null), null);
  assert.equal(H.parseHosted([]), null);
  assert.equal(H.parseHosted({}), null);
  assert.equal(H.parseHosted({ render: { available: "yes", enabled: true } }), null, "available 不是布尔值不收");
  assert.deepEqual(H.parseHosted({ render: { available: true, enabled: false }, junk: 1 }), { render: { available: true, enabled: false } });
  assert.deepEqual(H.parseHosted(ON), ON);
});

test("HR24a 显示条件:只有放云端且 available 才有这一行;缺省勾上(记录里没有算开)", () => {
  assert.deepEqual(H.hostedRowsOf("hosted", ON), [{ service: "render", label: "托管方的渲染节点", enabled: true }]);
  assert.deepEqual(H.hostedRowsOf("hosted", OFF), [{ service: "render", label: "托管方的渲染节点", enabled: false }]);
  assert.deepEqual(H.hostedRowsOf("lan", ON), [], "放本机的项目没有这一项");
  assert.deepEqual(H.hostedRowsOf(null, ON), []);
  assert.deepEqual(H.hostedRowsOf("hosted", null), [], "没有 hosted 字段(旧托管端)没有这一项");
  assert.deepEqual(H.hostedRowsOf("hosted", { render: { available: false, enabled: true } }), [], "登记表里没有这个服务");
  assert.deepEqual(H.hostedRowsOf("hosted", { agent: { available: true, enabled: true } }), [{ service: "agent", label: "云端 Agent", enabled: true }], "云端 Agent 一行:托管端有这个服务才出现,缺省勾上");
  assert.deepEqual(H.hostedRowsOf("hosted", { render: { available: true, enabled: true }, agent: { available: true, enabled: false } }).map((r) => [r.service, r.enabled]), [["render", true], ["agent", false]], "两行都在,渲染节点在前");
  assert.deepEqual(H.hostedRowsOf("lan", { agent: { available: true, enabled: true } }), [], "放本机的项目没有云端 Agent 一行");
});

test("CAU-SW-01 云端 Agent 一行的文案与同组一致;成员行下的云端 Agent 连接与署名", () => {
  const t = H.HOSTED_SERVICE_TEXT.agent;
  assert.equal(t.label, "云端 Agent");
  for (const on of [true, false]) for (const f of [t.hint, t.confirm]) assert.ok(f(on).length > 8);
  assert.ok(t.changed(false).length > 8);
  assert.equal(t.changed(true), "", "只在关闭时给别的成员气泡,打开时不提示〔用户 2026-10-07 定〕");
  assert.equal(H.HOSTED_SERVICE_TEXT.render.changed(true), "", "渲染节点同一个规矩:只在关闭时给别的成员气泡,打开时不提示〔用户 2026-10-07 定〕");
  assert.match(H.HOSTED_SERVICE_TEXT.render.changed(false), /创建者关闭了托管方的渲染节点/);
  assert.match(t.hint(false), /已关闭/);
  assert.match(t.changed(false), /创建者关闭了云端 Agent/);
  assert.notEqual(H.HOSTED_SERVICE_TEXT.render.confirm(false), t.confirm(false), "确认弹窗的话按服务各写各的");
  const conns = [{ role: "page" }, { role: "agent", conversation: 2 }, { role: "agent", conversation: "cc-1", service: "agent" }];
  assert.deepEqual(H.cloudAgentConns(conns), [{ role: "agent", conversation: "cc-1", service: "agent" }]);
  assert.equal(H.cloudAgentLabel("alice"), "alice的云端 Agent");
});

test("HR24a 通知落到状态上:认得的服务才改;不认识或这个项目没有这项服务就原样", () => {
  assert.deepEqual(H.applyHostedChange(ON, "render", false), { ...ON, render: { available: true, enabled: false } });
  assert.equal(H.applyHostedChange(ON, "nope", false), ON);
  assert.equal(H.applyHostedChange(ON, "render", "no"), ON);
  assert.equal(H.applyHostedChange(null, "render", false), null);
  assert.equal(H.applyHostedChange({ agent: { available: true, enabled: true } }, "render", false).render, undefined, "没有 render 这一项就不凭空造出来");
});

test("HR24a 成员列表:服务行在成员之后、不计入成员数;服务名不看用户名", () => {
  const row = (username, extra = {}) => ({ username, displayName: username, deviceId: `${username}-d`, deviceName: null, creator: false, tags: { editing: false, rendering: false, agents: 0 }, conns: [], ...extra });
  const rows = [row("service:render", { service: "render", conns: [{ role: "render" }] }), row("bob"), row("alice", { creator: true })];
  const { people, services } = H.splitMembers(rows);
  assert.deepEqual(people.map((r) => r.username), ["bob", "alice"]);
  assert.deepEqual(services.map((r) => r.service), ["render"]);
  assert.equal(H.serviceRowLabel("render"), "托管方的渲染节点");
  assert.equal(H.serviceRowLabel("something-else"), "托管方的服务");
  assert.equal(H.serviceRowLabel(undefined), "托管方的服务");
});

/** 渲染 HostedServiceRows(TSX 经 vite 的 ssrLoadModule 载入,与 stageLocalOnly.test.mjs 同一做法) */
async function withRows(fn) {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const M = await server.ssrLoadModule("/src/editor/sync/HostedServiceRows.tsx");
    const render = (props) => renderToStaticMarkup(React.createElement(M.HostedServiceRows, { onToggle: () => {}, ...props }));
    await fn({ M, render });
  } finally {
    await server.close();
  }
}

const checkboxOf = (html) => html.match(/<input[^>]*data-pc="collab-hosted-render-toggle"[^>]*>/)?.[0] ?? null;

test("HR24b 没有这一项的情况:放本机、没有 hosted 字段、available 为假", () => withRows(({ render }) => {
  assert.equal(render({ where: "lan", hosted: ON, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: null, creator: true }), "");
  assert.equal(render({ where: "hosted", hosted: { render: { available: false, enabled: true } }, creator: true }), "");
}));

test("HR24b 放云端且 available:出现,缺省勾上;创建者能改,成员只读", () => withRows(({ render }) => {
  const asCreator = render({ where: "hosted", hosted: ON, creator: true });
  assert.match(asCreator, /托管方的渲染节点/);
  const box = checkboxOf(asCreator);
  assert.ok(box, "有勾选框");
  assert.match(box, /checked=""/, "缺省勾上");
  assert.doesNotMatch(box, /disabled/, "创建者可以改");
  assert.doesNotMatch(asCreator, /只有创建者能改/);

  const asMember = render({ where: "hosted", hosted: ON, creator: false });
  const memberBox = checkboxOf(asMember);
  assert.match(memberBox, /checked=""/);
  assert.match(memberBox, /disabled=""/, "成员只读");
  assert.match(asMember, /只有创建者能改/);

  const closed = render({ where: "hosted", hosted: OFF, creator: true });
  assert.doesNotMatch(checkboxOf(closed), /checked/, "关掉后不勾");
  assert.match(closed, /已关闭/);

  const busy = render({ where: "hosted", hosted: ON, creator: true, busy: true });
  assert.match(checkboxOf(busy), /disabled=""/, "忙的时候创建者也不能再点");
}));

test("HR24b 点勾选:把要改成什么交给上层(创建者身份验证由上层的 CreatorFlow 做)", () => withRows(({ M }) => {
  // 直接取元素树里勾选框的 onChange,不起 DOM
  const tree = M.HostedServiceRows({ where: "hosted", hosted: ON, creator: true, onToggle: (...a) => calls.push(a) });
  const calls = [];
  const find = (node) => {
    if (!node || typeof node !== "object") return null;
    if (node.type === "input") return node;
    const kids = React.Children.toArray(node.props?.children);
    for (const k of kids) { const r = find(k); if (r) return r; }
    return null;
  };
  const input = find(tree);
  assert.ok(input, "找得到勾选框");
  input.props.onChange({ target: { checked: false } });
  input.props.onChange({ target: { checked: true } });
  assert.deepEqual(calls, [["render", false], ["render", true]]);
}));

/* ---------------- 第四段:项目设置里「云端 Agent」一行、署名(契约 `docs/plan/cloud-agent-contract.md` 第 5、9.5 节) ---------------- */

const agentBoxOf = (html) => html.match(/<input[^>]*data-pc="collab-hosted-agent-toggle"[^>]*>/)?.[0] ?? null;

test("CAU-SW-02 项目设置里「云端 Agent」一行:放云端且 hosted.agent.available 才出现,缺省勾上;创建者能改,成员只读", () => withRows(({ render }) => {
  const BOTH = { render: { available: true, enabled: true }, agent: { available: true, enabled: true } };
  assert.equal(agentBoxOf(render({ where: "hosted", hosted: ON, creator: true })), null, "这台托管端没有云端 Agent(available 为假):没有这一行");
  assert.equal(render({ where: "lan", hosted: BOTH, creator: true }), "", "放本机的项目没有");
  const asCreator = render({ where: "hosted", hosted: BOTH, creator: true });
  assert.match(asCreator, /云端 Agent/);
  assert.match(asCreator, /AI 栏里选「云端」/, "有一行说明");
  assert.match(agentBoxOf(asCreator), /checked=""/, "缺省勾上");
  assert.doesNotMatch(agentBoxOf(asCreator), /disabled/, "创建者可以改");
  assert.ok(asCreator.indexOf("托管方的渲染节点") < asCreator.indexOf("云端 Agent"), "与渲染节点的开关放在一起,在它后面");
  const asMember = render({ where: "hosted", hosted: BOTH, creator: false });
  assert.match(agentBoxOf(asMember), /disabled=""/, "成员只读");
  const closed = render({ where: "hosted", hosted: { ...BOTH, agent: { available: true, enabled: false } }, creator: false });
  assert.doesNotMatch(agentBoxOf(closed), /checked/);
  assert.match(closed, /已关闭:成员不能再用云端 Agent|已关闭：成员不能再用云端 Agent/);
}));

test("CAU-SIGN-01 署名:云端 Agent 的改动别人看到「〈成员名〉的云端 Agent」,发起的设备上是「你的云端 Agent」;本机 Agent 的说法不变", async () => {
  const server = await createServer({ root: ROOT, configFile: false, logLevel: "error", server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    appType: "custom", optimizeDeps: { noDiscovery: true, include: [] } });
  try {
    const L = await server.ssrLoadModule("/src/editor/sync/labels.ts");
    const bob = { session: "s-bob", userId: "bob@dev-b" };
    const cloud = { userId: "alice@dev-a", deviceId: "dev-a", role: "agent", conversation: 3, session: "s-agent", service: "agent" };
    // 两种形状都认:DocSync 记的 { actor, session },与文档服务直接给的 actor 本身
    assert.equal(L.writerLabel({ actor: cloud, session: "s-agent" }, bob), "alice的云端 Agent");
    assert.equal(L.writerLabel(cloud, bob), "alice的云端 Agent");
    // 发起成员不在线(成员列表里查不到显示名)时照样有名字;在线、重名带设备名时也只用用户名
    assert.equal(L.writerLabel({ actor: cloud }, bob, new Map([["alice@dev-a", "alice (电脑)"]])), "alice的云端 Agent");
    // 用户名里带 @ 的:取最后一个 @ 之前
    assert.equal(L.writerLabel({ actor: { ...cloud, userId: "a@b@dev-a" } }, bob), "a@b的云端 Agent");
    // 发起的那台设备上
    assert.equal(L.writerLabel({ actor: cloud }, { session: "s-alice", userId: "alice@dev-a" }), "你的云端 Agent");
    // 同一位成员在另一台设备上看:按名字说
    assert.equal(L.writerLabel({ actor: cloud }, { session: "s-alice-2", userId: "alice@dev-a2" }), "alice的云端 Agent");
    // 本机 Agent 的说法不变
    const local = { userId: "alice@dev-a", deviceId: "dev-a", role: "agent", conversation: 2, session: "s-x" };
    assert.equal(L.writerLabel({ actor: { ...local, username: "alice" } }, bob, new Map([["alice@dev-a", "alice"]])), "alice · Agent · 第 2 个对话");
    assert.equal(L.writerLabel({ actor: local }, bob), "Agent「第 2 个对话」");
    assert.equal(L.writerLabel({ actor: local }, { session: "s-alice", userId: "alice@dev-a" }), "Agent「第 2 个对话」");
    assert.equal(L.writerLabel({ actor: { userId: "alice@dev-a", role: "page", session: "s-p" } }, bob, new Map([["alice@dev-a", "alice"]])), "alice");
  } finally {
    await server.close();
  }
});

const mrow = (username, conns, extra = {}) => ({ username, displayName: username, deviceId: `${username}-d`, deviceName: null, creator: false, tags: { editing: conns.some((c) => c.role === "page"), rendering: false, agents: conns.filter((c) => c.role === "agent").length }, conns, ...extra });

/** 「有一轮在跑」表:成员键是 用户名@设备号(与成员行的 `${username}@${deviceId}` 同一写法,mrow 的设备号是 `<用户名>-d`) */
const running = (...names) => new Set(names.map((n) => `${n}@${n}-d`));
const NONE = new Set();

test("CAU-MEM-01 成员计数口径〔用户 2026-10-07 定,同日改按「一轮在跑」〕:人数只算真人在线;Agent 数 = 本机 + 有一轮在跑的云端;离线只剩闲置云端连接的不显示", () => {
  const alice = mrow("alice", [{ role: "page" }, { role: "agent", conversation: 1 }, { role: "agent", conversation: 2 }]);
  const bob = mrow("bob", [{ role: "page" }, { role: "agent", conversation: "cc-1", service: "agent" }, { role: "agent", conversation: "cc-1", service: "agent" }]);
  const carol = mrow("carol", [{ role: "agent", conversation: "cc-2", service: "agent" }]);
  const render = mrow("service:render", [{ role: "render" }], { service: "render" });
  const { people } = H.splitMembers([alice, bob, carol, render]);
  assert.equal(people.length, 3, "渲染节点那一行不进成员");
  // 谁都没有一轮在跑:bob 的云端 Agent 闲置(不计),carol 本人不在线、只剩闲置连接(整行不显示、不计)
  assert.deepEqual(H.memberCounts(people, NONE), { people: 2, agents: 2 }, "只剩 alice 的本机 Agent 2 个;bob、carol 的云端连接都闲置,不计");
  assert.deepEqual(H.visibleMembers(people, NONE).map((r) => r.username), ["alice", "bob"], "carol 本人不在线、只剩闲置的云端 Agent 连接:这一行不显示");
  assert.equal(H.memberCountLabel(people, NONE), "成员：2 人 · Agent：2 个");
  assert.equal(H.isCloudAgentOnly(carol, NONE), false, "闲置的不标「离线,Agent 在跑」");
  assert.equal(H.isIdleCloudAgentOnly(carol, NONE), true);
  assert.equal(H.isCloudAgentRunning(bob, NONE), false, "本人在线、云端 Agent 闲置:不显示「[云端 Agent]」标记");
  // bob、carol 各有一轮在跑:bob 云端算 1 个(多条连接只算一个),carol 的行回来、标「离线,Agent 在跑」、计入 Agent 数、不计入人数
  const both = running("bob", "carol");
  assert.deepEqual(H.memberCounts(people, both), { people: 2, agents: 4 }, "真人在线 alice、bob;Agent:alice 本机 2 个 + bob 云端 1 个 + carol 云端 1 个");
  assert.equal(H.memberCountLabel(people, both), "成员：2 人 · Agent：4 个");
  assert.deepEqual(H.visibleMembers(people, both).map((r) => r.username), ["alice", "bob", "carol"]);
  assert.equal(H.isPersonOnline(alice), true);
  assert.equal(H.isPersonOnline(carol), false);
  assert.equal(H.isCloudAgentOnly(carol, both), true, "本人不在线、云端 Agent 有一轮在跑:标「离线,Agent 在跑」");
  assert.equal(H.isCloudAgentOnly(bob, both), false, "本人在线的不标");
  assert.equal(H.isCloudAgentRunning(bob, both), true, "本人在线、一轮在跑:显示「[云端 Agent]」标记");
  assert.equal(H.isCloudAgentOnly(alice, both), false);
  assert.equal(H.isCloudAgentOnly(mrow("dave", []), running("dave")), false, "没有任何连接不算");
  // 表里有这位成员、但他名下并没有云端 Agent 的连接(成员列表还没跟上):不算
  assert.equal(H.isCloudAgentRunning(alice, running("alice")), false, "没有云端 Agent 连接,表里有也不算");
  assert.equal(H.memberKeyOf(alice), "alice@alice-d", "成员键是 用户名@设备号");
});

test("CAU-MEM-02 成员计数:只有自己在线时是「成员:1 人 · Agent:0 个」;自己带本机 Agent、一轮在跑的云端 Agent 都计入 Agent;自己那一行也按这张表", () => {
  assert.equal(H.memberCountLabel([], NONE), "成员：1 人 · Agent：0 个", "自己总是在线,人数至少 1");
  const me = mrow("me", [{ role: "page" }]);
  assert.equal(H.memberCountLabel([me], NONE), "成员：1 人 · Agent：0 个");
  const me2 = mrow("me", [{ role: "page" }, { role: "agent", conversation: 1 }, { role: "agent", conversation: "cc-9", service: "agent" }]);
  assert.equal(H.memberCountLabel([me2], NONE), "成员：1 人 · Agent：1 个", "自己的云端 Agent 闲置:只算本机的 1 个");
  assert.equal(H.memberCountLabel([me2], running("me")), "成员：1 人 · Agent：2 个", "自己的云端 Agent 有一轮在跑:本机 1 + 云端 1");
  assert.equal(H.isCloudAgentRunning(me2, running("me")), true, "自己那一行也按这张表显示「[云端 Agent]」");
  assert.equal(H.isCloudAgentRunning(me2, NONE), false);
  // 只有自己的云端 Agent 连着(自己的页面都关了):闲置时整行不显示、不计;一轮在跑时标「离线,Agent 在跑」、计 Agent、不计人数
  const gone = mrow("gone", [{ role: "agent", conversation: "cc-3", service: "agent" }]);
  assert.equal(H.memberCountLabel([me, gone], NONE), "成员：1 人 · Agent：0 个");
  assert.equal(H.memberCountLabel([me, gone], running("gone")), "成员：1 人 · Agent：1 个");
  assert.equal(H.isCloudAgentOnly(gone, running("gone")), true);
});
