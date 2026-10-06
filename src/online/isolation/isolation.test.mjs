/**
 * 舞台这一侧的隔离:加固里的纯判定、自检的结论、执行闸门、舞台入口的认定(契约 `docs/plan/online-card-exec-contract.md` 第 3 节)。
 * 加固钩子与自检在真实浏览器里的行为由 `scripts/probes/online-card-security-probe.mjs` 断言。
 * 跑:node --test src/online/isolation/isolation.test.mjs
 */
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { FRAME_TAGS, htmlHasFrame, isFrameName } from "./harden.ts";
import { judgeIsolation, ISOLATION_CHECK_EXTERNAL_URL } from "./isolationCheck.ts";
import { cardExecGate, subscribeCardExecGate, markIsolatedStageDocument, setIsolationReport, noteMediaPolicy, noteBreach, resetExecGateForTest } from "./execGate.ts";
import { bootStageGuard, isStageEntryPath, announceStageIsolation, STAGE_ENTRY_FILE, resetStageGuardForTest } from "./stageGuard.ts";

const HARDENED = { installed: true, webrtcRemoved: true, trustedTypes: "enforced", hooks: 38, errors: [] };
const OK_REPORT = judgeIsolation({ crossOrigin: true, csp: "header", allowlist: true, harden: HARDENED });

beforeEach(() => { resetExecGateForTest(); resetStageGuardForTest(); });

test("OCS-H-01 带子框架的 HTML 串:七种标签、大小写、带前缀、标签名前有空白都认;实体声明也拒;相近的名字不误伤", () => {
  for (const tag of FRAME_TAGS) {
    assert.ok(htmlHasFrame(`<${tag}>`), tag);
    assert.ok(htmlHasFrame(`<div><${tag.toUpperCase()} src="x"></div>`), tag);
    assert.ok(htmlHasFrame(`<x:${tag} xmlns:x="http://www.w3.org/1999/xhtml"/>`), tag);
    assert.ok(htmlHasFrame(`< ${tag}/>`), tag);
  }
  assert.ok(htmlHasFrame("<svg><foreignObject><iframe/></foreignObject></svg>"));
  assert.ok(htmlHasFrame('<!DOCTYPE r [<!ENTITY f "&#60;iframe/&#62;">]><r>&f;</r>'), "实体展开能在源文本里不出现标签名的情况下造出元素");
  assert.ok(htmlHasFrame("<!entity x 'y'>"));
  for (const fine of ["", "<div>iframe</div>", "<p>object embed frame</p>", "<svg><foreignObject><div/></foreignObject></svg>", "<frame-like-custom></frame-like-custom>",
    "<objectives>", "<embedded>", "<iframes>", "<my-iframe>", "&lt;iframe&gt;", "<div data-x=\"<b>\">", null, undefined, 42]) {
    assert.equal(htmlHasFrame(fine), false, String(fine));
  }
});

test("OCS-H-02 元素名是不是子框架类:大小写、前缀、首尾空白都认;别的不认", () => {
  for (const name of ["iframe", "IFRAME", "iFrAmE", "html:iframe", "x:OBJECT", "embed", "frame", "frameset", "portal", "fencedframe", " iframe "]) assert.ok(isFrameName(name), name);
  for (const name of ["div", "foreignObject", "my-iframe", "iframes", "object-fit", "", null, undefined, "video"]) assert.equal(isFrameName(name), false, String(name));
});

test("OCS-H-03 自检的结论:跨源、策略出自响应头、加固装上、出口有人拦,四样都有才算隔离", () => {
  assert.deepEqual(OK_REPORT, { ok: true, crossOrigin: true, csp: "header", egress: "allowlist", hardened: true, trustedTypes: "enforced", reasons: [] });
  // 浏览器不认出口白名单:靠脚本加固(Trusted Types 在强制、构造器已去掉)也算,但记成 script
  assert.deepEqual(judgeIsolation({ crossOrigin: true, csp: "header", allowlist: false, harden: HARDENED }).egress, "script");
  assert.equal(judgeIsolation({ crossOrigin: true, csp: "header", allowlist: false, harden: HARDENED }).ok, true);
  const cases = [
    [{ crossOrigin: false, csp: "header", allowlist: true, harden: HARDENED }, ["same-origin"]],
    [{ crossOrigin: true, csp: "none", allowlist: true, harden: HARDENED }, ["no-policy"]],
    // 只有 <meta> 兜底 = 托管端的 nginx 没更新(或放在没有 nginx 的本机):不算隔离
    [{ crossOrigin: true, csp: "meta", allowlist: false, harden: HARDENED }, ["meta-only"]],
    [{ crossOrigin: true, csp: "header", allowlist: true, harden: null }, ["not-hardened"]],
    [{ crossOrigin: true, csp: "header", allowlist: true, harden: { ...HARDENED, webrtcRemoved: false } }, ["not-hardened"]],
    // 没有出口白名单,Trusted Types 又没在强制:WebRTC 没人拦
    [{ crossOrigin: true, csp: "header", allowlist: false, harden: { ...HARDENED, trustedTypes: "created" } }, ["no-egress-guard"]],
    [{ crossOrigin: true, csp: "header", allowlist: false, harden: { ...HARDENED, trustedTypes: "unsupported" } }, ["no-egress-guard"]],
    [{ crossOrigin: false, csp: "none", allowlist: false, harden: null }, ["same-origin", "no-policy", "not-hardened", "no-egress-guard"]],
  ];
  for (const [facts, reasons] of cases) {
    const r = judgeIsolation(facts);
    assert.equal(r.ok, false, JSON.stringify(facts));
    assert.deepEqual(r.reasons, reasons, JSON.stringify(facts));
  }
  assert.ok(ISOLATION_CHECK_EXTERNAL_URL.endsWith(".invalid/"), "自检用的外部地址是永远解析不出来的保留域");
});

test("OCS-H-04 执行闸门:不是舞台文档、自检没出结果、自检没过、父页没点头,都不执行;四样齐了才开", () => {
  assert.deepEqual({ allowed: cardExecGate().allowed, reason: cardExecGate().reason }, { allowed: false, reason: "not-stage" });
  // 不是舞台文档:父页怎么点头都不开
  noteMediaPolicy({ cardExec: true });
  assert.equal(cardExecGate().reason, "not-stage");
  markIsolatedStageDocument();
  assert.equal(cardExecGate().reason, "checking");
  setIsolationReport(judgeIsolation({ crossOrigin: true, csp: "meta", allowlist: false, harden: HARDENED }));
  assert.equal(cardExecGate().reason, "not-isolated");
  setIsolationReport(OK_REPORT);
  assert.equal(cardExecGate().reason, "ok");
  assert.equal(cardExecGate().allowed, true);
  // 父页收回(另一台没过、总开关关了):关上;再点头再开
  noteMediaPolicy({ cardExec: false });
  assert.deepEqual({ allowed: cardExecGate().allowed, reason: cardExecGate().reason }, { allowed: false, reason: "parent" });
  noteMediaPolicy(null);
  assert.equal(cardExecGate().reason, "parent");
  noteMediaPolicy({ cardExec: true, ticket: null });
  assert.equal(cardExecGate().allowed, true);
});

test("OCS-H-05 执行闸门·要执行就不放秘密:见过票据的文档永久不执行;开过闸门的文档不再收票据", () => {
  markIsolatedStageDocument();
  setIsolationReport(OK_REPORT);
  // 旧办法:父页给了带票据的取档策略 → 这份票据可以用,但本文档永久不执行(哪怕父页同时点头)
  assert.deepEqual(noteMediaPolicy({ ticket: "v1.aaa.bbb", cardExec: true }), { acceptTicket: true });
  assert.equal(cardExecGate().reason, "ticket-seen");
  noteMediaPolicy({ cardExec: true, ticket: null });
  assert.equal(cardExecGate().reason, "ticket-seen", "之后不带票据再点头也不开");
  assert.equal(cardExecGate().allowed, false);

  resetExecGateForTest();
  markIsolatedStageDocument();
  setIsolationReport(OK_REPORT);
  noteMediaPolicy({ cardExec: true });
  assert.equal(cardExecGate().allowed, true);
  // 闸门开过(可能跑过用户代码)之后再来的票据:不收,调用方把它丢掉
  assert.deepEqual(noteMediaPolicy({ ticket: "v1.aaa.bbb" }), { acceptTicket: false });
  assert.equal(cardExecGate().allowed, false);
  assert.equal(cardExecGate().reason, "parent");
  // 没票据的策略:acceptTicket 为假(没有票据可收)
  assert.deepEqual(noteMediaPolicy({ ticket: "", cardExec: true }), { acceptTicket: false });
});

test("OCS-H-06 执行闸门·加固拦下过造子框架的代码:永久关上;状态变了通知订阅方、没变不通知", () => {
  markIsolatedStageDocument();
  setIsolationReport(OK_REPORT);
  let calls = 0;
  const off = subscribeCardExecGate(() => { calls++; });
  noteMediaPolicy({ cardExec: true });
  assert.equal(calls, 1);
  const same = cardExecGate();
  noteMediaPolicy({ cardExec: true });
  assert.equal(calls, 1);
  assert.equal(cardExecGate(), same, "状态没变时对象身份不变");
  noteBreach();
  assert.equal(calls, 2);
  assert.deepEqual({ allowed: cardExecGate().allowed, reason: cardExecGate().reason }, { allowed: false, reason: "breach" });
  noteMediaPolicy({ cardExec: true });
  setIsolationReport(OK_REPORT);
  assert.equal(cardExecGate().reason, "breach");
  off();
  noteMediaPolicy({ cardExec: false });
  assert.equal(calls, 2);
});

test("OCS-H-07 舞台入口按路径认:只有 stage.html;编辑器页、同源单舞台(/editor/?stage=1)、导出页都不是", () => {
  assert.equal(STAGE_ENTRY_FILE, "stage.html");
  for (const p of ["/editor/stage.html", "/stage.html", "/a/b/stage.html"]) assert.ok(isStageEntryPath(p), p);
  for (const p of ["/editor", "/editor/", "/editor/index.html", "/editor/stage.html/", "/editor/xstage.html", "/editor/stage.htm", "", "/"]) assert.equal(isStageEntryPath(p), false, p);
});

test("OCS-H-08 启动钩子:不是在线构建、不在浏览器里、不是舞台入口都不做事(不装加固、闸门留在 not-stage、不向父页发消息)", () => {
  // Node 里没有 window:任何组合都不做事
  assert.equal(bootStageGuard({ online: true, base: "/editor/" }), false);
  assert.equal(bootStageGuard({ online: false, base: "/editor/" }), false);
  assert.equal(cardExecGate().reason, "not-stage");
  assert.doesNotThrow(() => announceStageIsolation());
  // 有 window 但路径不是舞台入口(编辑器页、同源单舞台):同样不做事,只留一个只读的观察口
  const posted = [];
  const fakeWindow = { parent: { postMessage: (m) => posted.push(m) } };
  globalThis.window = fakeWindow;
  globalThis.location = { pathname: "/editor/" };
  try {
    assert.equal(bootStageGuard({ online: true, base: "/editor/" }), false);
    assert.equal(cardExecGate().reason, "not-stage");
    assert.deepEqual(fakeWindow.__pcCardExecGate(), { allowed: false, reason: "not-stage" });
    assert.equal(fakeWindow.__pcStageIsolation, undefined);
    announceStageIsolation();
    assert.equal(posted.length, 0);
    // 桌面运行环境(不是在线构建)连观察口都不留
    delete fakeWindow.__pcCardExecGate;
    globalThis.location = { pathname: "/editor/stage.html" };
    assert.equal(bootStageGuard({ online: false, base: "/" }), false);
    assert.equal(fakeWindow.__pcCardExecGate, undefined);
  } finally {
    delete globalThis.window;
    delete globalThis.location;
  }
});
