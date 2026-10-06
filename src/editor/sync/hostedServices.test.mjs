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
  assert.deepEqual(H.hostedRowsOf("hosted", { agent: { available: true, enabled: true } }), [], "agent 的开关界面是第四段的事,现在不出行");
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
    const M = await server.ssrLoadModule("/src/editor/sync/HostedServices.tsx");
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
