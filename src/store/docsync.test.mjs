/**
 * docsync(页面到文档服务的同步层)的测试。跑:node --test src/store/docsync.test.mjs
 *
 * 用 src/testing/memDocService.mjs 的内存文档服务假件,消息随机交错投递。钉的是 c65-design.md:
 *   V2:两个页面各 200 次随机编辑交错提交,两边与文档服务三份逐字节相同;
 *   V5:撤销不盖别人(这一步之后被别的写入身份改过的实体不撤);
 *   V6:离线队列(按顺序落地;第一条被拒整批停下,「重放」「丢弃」);
 *   V7:.proc 只在所有本地操作确认后写(whenSettled);
 *   V8:1000 个片段的项目,提交一侧的差异计算 ≤ 5 ms。
 */
import { srcUrl } from "../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

import { MemDocService } from "../testing/memDocService.mjs";
import { rng, randProject, mutateOnce, realisticEdit, bigProject } from "../testing/randomProject.mjs";

const { DocSync } = await import(srcUrl("store/docsync.ts"));

const json = (v) => JSON.stringify(v);

/** 一个页面:DocSync + 接到假件上的连接 */
function page(svc, session, initial, extra = {}) {
  const sent = [];
  const backups = [];
  const notices = [];
  let link = null;
  const ds = new DocSync(initial, {
    projectId: "P",
    session,
    send: (msg) => {
      sent.push(msg);
      link?.send(msg);
    },
    saveBackup: (b) => backups.push(b),
    ...extra,
  });
  ds.on("notice", (n) => notices.push(n));
  const up = () => {
    link = svc.connect(session, (msg) => ds.receive(msg));
    ds.connect();
  };
  const down = (opts) => {
    if (link) svc.disconnect(link.conn, opts);
    link = null;
    ds.disconnect();
  };
  up();
  return { ds, sent, backups, notices, up, down, get conn() { return link?.conn; } };
}

/** 本地做一次随机修改,交给 docsync。chaos:整份深拷贝后在任意位置乱改(换类型、删键、重复 id…) */
function randomEdit(r, ds, chaos) {
  if (!chaos) return ds.commit(realisticEdit(r, ds.project));
  const next = structuredClone(ds.project);
  mutateOnce(r, next);
  ds.commit(next);
}

function twoPages(seed, projectOpts) {
  const r = rng(seed);
  const p0 = randProject(r, projectOpts);
  const svc = new MemDocService({ project: structuredClone(p0), rev: 7 });
  const A = page(svc, "A", structuredClone(p0));
  const B = page(svc, "B", structuredClone(p0));
  svc.drain();
  return { r, svc, A, B };
}

function assertSame(svc, ...pages) {
  const s = json(svc.project);
  for (const p of pages) {
    assert.equal(json(p.ds.project), s, `${p.ds.session} 与文档服务不一致`);
    assert.equal(p.ds.rev, svc.rev, `${p.ds.session} 的版本号 ${p.ds.rev} ≠ ${svc.rev}`);
    assert.equal(p.ds.unconfirmed, 0);
  }
}

/* ---------------- V2 ---------------- */

for (const [seed, chaos] of [[1, false], [2, false], [3, false], [4, false], [5, false], [6, true], [7, true], [8, true]]) {
  test(`V2-两个页面各 200 次随机${chaos ? "乱改" : "编辑"}交错提交,三份逐字节相同(种子 ${seed})`, () => {
    const { r, svc, A, B } = twoPages(seed);
    const left = { A: 200, B: 200 };
    let undos = 0;
    while (left.A || left.B) {
      const roll = r.int(10);
      if (roll < 4) {
        svc.step(r);
      } else {
        const who = left.A && (!left.B || r.chance(0.5)) ? "A" : "B";
        const p = who === "A" ? A : B;
        left[who]--;
        // 偶尔撤销 / 重做,撤销也是一次普通写入
        if (roll === 9 && p.ds.canUndo()) { p.ds.undo(); undos++; }
        else if (roll === 8 && p.ds.canRedo()) p.ds.redo();
        else randomEdit(r, p.ds, chaos);
      }
    }
    svc.drain(r);
    assertSame(svc, A, B);
    // 账对得上:每条发出去的提交要么落地、要么被拒并通知了页面,没有悄悄丢的;落地的没有重复
    for (const p of [A, B]) {
      const sentIds = new Set(p.sent.filter((m) => m.type === "project.op").map((m) => m.opId));
      const landed = svc.log.filter((e) => e.session === p.ds.session).map((e) => e.opId);
      const rejectedIds = p.notices.filter((n) => n.kind === "rejected").map((n) => n.opId);
      assert.equal(new Set(landed).size, landed.length);
      assert.equal(sentIds.size, landed.length + rejectedIds.length, `${p.ds.session}:发出 ${sentIds.size},落地 ${landed.length},被拒 ${rejectedIds.length}`);
    }
    const bySession = { A: 0, B: 0 };
    for (const e of svc.log) bySession[e.session]++;
    const rejected = [...A.notices, ...B.notices].filter((n) => n.kind === "rejected" || n.kind === "replay-dropped").length;
    console.log(`V2 种子 ${seed}${chaos ? "(乱改)" : ""}:落地 A ${bySession.A}、B ${bySession.B},被拒或重放丢弃 ${rejected},撤销 ${undos},最终 rev ${svc.rev}`);
    assert.ok(bySession.A >= 60 && bySession.B >= 60, JSON.stringify(bySession));
    assert.ok(undos > 0);
  });
}

test("V2-收到别人的操作不进自己的撤销栈、不回发", () => {
  const { svc, A, B } = twoPages(11);
  const next = structuredClone(A.ds.project);
  next.name = "A 改的";
  A.ds.commit(next);
  svc.drain();
  assert.equal(B.ds.project.name, "A 改的");
  assert.equal(B.ds.canUndo(), false);
  assert.equal(B.sent.filter((m) => m.type === "project.op").length, 0);
  assertSame(svc, A, B);
});

test("V2-有未确认操作时收到远端操作:撤回、应用远端、重放,本地先看到自己的改动", () => {
  const { svc, A, B } = twoPages(12);
  const a = structuredClone(A.ds.project);
  a.width = 111;
  A.ds.commit(a);
  const b = structuredClone(B.ds.project);
  b.height = 222;
  B.ds.commit(b);
  // B 的先落地;A 的还在路上时先收到 B 的
  svc.handle(B.conn, B.conn.up.shift());
  svc.handle(A.conn, A.conn.up.shift());
  A.conn.onMessage(A.conn.down.shift()); // project.ops(B 的)
  assert.equal(A.ds.project.width, 111);
  assert.equal(A.ds.project.height, 222);
  svc.drain();
  assertSame(svc, A, B);
});

/* ---------------- V5 ---------------- */

function clipsProject() {
  return {
    version: 1, id: "p", name: "p", width: 1920, height: 1080, fps: 30, duration: 30, themeId: "midnight", media: [],
    tracks: [{ id: "t1", name: "序列 1", clips: [
      { id: "c1", cardId: "title", start: 0, end: 2, params: { text: "一" } },
      { id: "c2", cardId: "title", start: 3, end: 5, params: { text: "二" } },
    ] }],
  };
}

function setupClips(extra) {
  const svc = new MemDocService({ project: clipsProject(), rev: 1, ...extra });
  const A = page(svc, "A", clipsProject());
  const B = page(svc, "B", clipsProject());
  svc.drain();
  return { svc, A, B };
}

const withText = (p, id, text) => ({ ...p, tracks: p.tracks.map((t) => ({ ...t, clips: t.clips.map((c) => (c.id === id ? { ...c, params: { ...c.params, text } } : c)) })) });
const textOf = (p, id) => p.tracks[0].clips.find((c) => c.id === id)?.params.text;

test("V5-A 改片段 1、2,B 随后改片段 2;A 撤销:片段 1 回去,片段 2 保持 B 的,A 知道片段 2 因 B 改过没撤", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(withText(A.ds.project, "c1", "A1"), "c2", "A2"));
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true);
  assert.deepEqual(res.skipped.map((s) => [s.entity, s.by.session]), [["/tracks/@t1/clips/@c2", "B"]]);
  assert.equal(textOf(A.ds.project, "c1"), "一");
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  svc.drain();
  assertSame(svc, A, B);
  // 撤销是一次新的写入,带 undoOf,别人照常收到
  const last = svc.log[svc.log.length - 1];
  assert.equal(last.session, "A");
  assert.equal(last.undoOf, svc.log[svc.log.length - 3].opId);
  assert.equal(textOf(B.ds.project, "c1"), "一");
  // 重做:把撤掉的那一处(片段 1)再做回来
  assert.equal(A.ds.canRedo(), true);
  const redo = A.ds.redo();
  assert.equal(redo.done, true);
  svc.drain();
  assert.equal(textOf(B.ds.project, "c1"), "A1");
  assert.equal(textOf(B.ds.project, "c2"), "B2");
  assertSame(svc, A, B);
  assert.ok(A.notices.some((n) => n.kind === "undo" && n.result.skipped.length === 1));
});

test("V5-全部没撤成:出栈,也不进重做栈", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c2", "A2"));
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, false);
  assert.equal(res.skipped.length, 1);
  assert.equal(A.ds.canUndo(), false);
  assert.equal(A.ds.canRedo(), false);
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-自己后来改过的不算冲突;别人改过又被我撤了中间一步,也照样挡住", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c2", "A2")); // 第 1 步
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c2", "B2"));
  svc.drain();
  A.ds.commit(withText(A.ds.project, "c2", "A3")); // 第 2 步,盖掉 B 的
  svc.drain();
  // 撤第 2 步:它之后没人改过 → 撤成,回到 B2
  assert.equal(A.ds.undo().done, true);
  svc.drain();
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  // 撤第 1 步:它之后 B 改过 → 不撤
  const res = A.ds.undo();
  assert.equal(res.done, false);
  assert.equal(textOf(A.ds.project, "c2"), "B2");
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-父级被别人删了:落不下去的那处记为没撤成,其余照撤", () => {
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const base = { ...clipsProject(), tracks: [...clipsProject().tracks, { id: "t2", name: "序列 2", clips: [{ id: "c9", cardId: "x", start: 0, end: 1, params: {} }] }] };
  svc.project = structuredClone(base);
  const A = page(svc, "A", structuredClone(base));
  const B = page(svc, "B", structuredClone(base));
  svc.drain();
  const a = structuredClone(A.ds.project);
  a.tracks[1].clips[0].start = 0.5;
  a.name = "A 的名字";
  A.ds.commit(a);
  svc.drain();
  const b = structuredClone(B.ds.project);
  b.tracks.splice(1, 1); // B 删了序列 2(实体 /tracks/@t2,与片段 c9 不是同一个实体)
  B.ds.commit(b);
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, true);
  assert.deepEqual(res.failed, ["/tracks/@t2/clips/@c9"]);
  assert.equal(A.ds.project.name, "p");
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-还没确认的一步也能撤;撤销后有新操作,重做栈清空", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "x"));
  A.ds.undo();
  assert.equal(textOf(A.ds.project, "c1"), "一");
  assert.equal(A.ds.canRedo(), true);
  A.ds.commit(withText(A.ds.project, "c2", "y"));
  assert.equal(A.ds.canRedo(), false);
  svc.drain();
  assertSame(svc, A, B);
});

test("V5-数字框 300 ms 内的连续输入合并成一步;超过 300 ms 另起一步;栈上限 100", () => {
  let t = 1000;
  const svc = new MemDocService({ project: clipsProject(), rev: 1 });
  const A = page(svc, "A", clipsProject(), { now: () => t });
  svc.drain();
  for (let i = 0; i < 5; i++) {
    A.ds.commit({ ...A.ds.project, width: 1000 + i }, { mergeKey: "width" });
    t += 100;
  }
  t += 400;
  A.ds.commit({ ...A.ds.project, width: 7 }, { mergeKey: "width" });
  svc.drain();
  assert.equal(svc.log.filter((e) => e.session === "A").length, 6); // 每次输入照样各提交一次
  A.ds.undo();
  assert.equal(A.ds.project.width, 1004);
  A.ds.undo();
  assert.equal(A.ds.project.width, 1920);
  assert.equal(A.ds.canUndo(), false);
  svc.drain();
  assertSame(svc, A);
  // 上限
  for (let i = 0; i < 130; i++) { t += 1000; A.ds.commit({ ...A.ds.project, fps: i + 1 }); }
  let n = 0;
  while (A.ds.canUndo()) { A.ds.undo(); n++; }
  assert.equal(n, 100);
  assert.equal(A.ds.project.fps, 30);
  svc.drain();
  assertSame(svc, A);
});

test("V5-别人撤销:画面直接变,不进我的栈", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.drain();
  A.ds.undo();
  svc.drain();
  assert.equal(textOf(B.ds.project, "c1"), "一");
  assert.equal(B.ds.canUndo(), false);
  assertSame(svc, A, B);
});

/* ---------------- 覆盖通知 ---------------- */

test("覆盖通知-被覆盖方先把自己那一版存成本地备份,覆盖方收到 overwrote", () => {
  const { svc, A, B } = setupClips({ overwriteWindowMs: 600_000 });
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.drain();
  B.ds.commit(withText(B.ds.project, "c1", "B1"));
  svc.drain();
  assert.ok(B.notices.some((n) => n.kind === "overwrote" && n.entities[0].entity === "/tracks/@t1/clips/@c1"));
  assert.equal(A.backups.length, 1);
  assert.equal(A.backups[0].kind, "overwritten");
  assert.equal(A.backups[0].entity, "/tracks/@t1/clips/@c1");
  assert.equal(A.backups[0].value.params.text, "A1"); // 是 A 自己原来那一版
  assert.equal(textOf(A.ds.project, "c1"), "B1");
  assertSame(svc, A, B);
});

/* ---------------- V6 ---------------- */

test("V6-断线期间改 20 次,恢复后按顺序落地,只有第一条带 expectRev", () => {
  const { svc, A, B } = setupClips();
  const rev0 = svc.rev;
  A.down();
  assert.equal(A.ds.status, "offline");
  for (let i = 0; i < 20; i++) A.ds.commit(withText(A.ds.project, "c1", `离线 ${i}`));
  assert.equal(svc.rev, rev0);
  A.sent.length = 0;
  A.up();
  svc.drain();
  const ops = A.sent.filter((m) => m.type === "project.op");
  assert.equal(ops.length, 20);
  assert.equal(ops[0].expectRev, rev0);
  assert.ok(ops.slice(1).every((m) => m.expectRev === undefined));
  assert.equal(svc.rev, rev0 + 20);
  assert.deepEqual(svc.log.slice(-20).map((e) => e.opId), ops.map((m) => m.opId));
  assert.equal(textOf(svc.project, "c1"), "离线 19");
  assert.equal(A.ds.status, "online");
  assertSame(svc, A, B);
});

function offlineConflict() {
  const ctx = setupClips();
  const { svc, A, B } = ctx;
  A.down();
  for (let i = 0; i < 20; i++) A.ds.commit(withText(A.ds.project, "c1", `离线 ${i}`));
  B.ds.commit(withText(B.ds.project, "c2", "B 在 A 离线时改的"));
  svc.drain();
  A.sent.length = 0;
  A.up();
  svc.drain();
  return ctx;
}

test("V6-离线期间别人也改过:第一条被拒,整批停下", () => {
  const { svc, A } = offlineConflict();
  assert.equal(A.ds.status, "paused");
  const info = A.ds.pausedInfo;
  assert.equal(info.queued, 20);
  assert.equal(info.since.length, 1);
  assert.equal(info.since[0].session, "B");
  assert.equal(A.sent.filter((m) => m.type === "project.op").length, 1); // 其余 19 条没发
  assert.equal(svc.log.filter((e) => e.session === "A").length, 0);
  assert.equal(textOf(A.ds.project, "c1"), "离线 19"); // 本地仍是离线时的样子
});

test("V6-选「重放」:去掉期望版本依次提交,三份一致,别人的改动也在", async () => {
  const { svc, A, B } = offlineConflict();
  A.ds.replayOffline();
  svc.drain();
  assert.equal(A.ds.status, "online");
  const sessions = svc.log.slice(-21).map((e) => e.session);
  assert.deepEqual(sessions, ["B", ...Array(20).fill("A")]);
  assert.ok(svc.log.slice(-20).every((e) => e.expectRev === undefined));
  assert.equal(textOf(svc.project, "c1"), "离线 19");
  assert.equal(textOf(svc.project, "c2"), "B 在 A 离线时改的");
  assertSame(svc, A, B);
  const settled = await A.ds.whenSettled({ timeoutMs: 100 });
  assert.equal(settled.rev, svc.rev);
});

test("V6-选「丢弃」:先把这批存成本地备份,本地回到服务端版本", () => {
  const { svc, A, B } = offlineConflict();
  const revBefore = svc.rev;
  A.ds.discardOffline();
  assert.equal(A.ds.status, "online");
  assert.equal(A.backups.length, 1);
  const b = A.backups[0];
  assert.equal(b.kind, "offline-discard");
  assert.equal(b.batch.length, 20);
  assert.equal(textOf(b.project, "c1"), "离线 19");
  assert.equal(A.ds.canUndo(), false);
  svc.drain();
  assert.equal(svc.rev, revBefore);
  assert.equal(textOf(A.ds.project, "c1"), "一");
  assertSame(svc, A, B);
});

test("V6-在途提交其实已落地、断线丢了 ok:重连后原 opId 重发,文档服务去重,不误判冲突", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "在途"));
  svc.handle(A.conn, A.conn.up.shift()); // 文档服务收到并落地
  A.down(); // ok 还没投就断了
  A.ds.commit(withText(A.ds.project, "c2", "离线"));
  A.up();
  svc.drain();
  assert.equal(A.ds.status, "online");
  assert.equal(svc.log.filter((e) => e.session === "A").length, 2);
  assertSame(svc, A, B);
});

test("V6-断线时在途提交没到文档服务:重连后照常补发", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit(withText(A.ds.project, "c1", "在途"));
  A.down(); // 上行丢了
  A.up();
  svc.drain();
  assert.equal(textOf(svc.project, "c1"), "在途");
  assertSame(svc, A, B);
});

/* ---------------- V7 ---------------- */

test("V7-有未确认操作时点保存:等到确认后才写,写出的内容与文档服务的 rev 一致", async () => {
  const { svc, A, B } = setupClips();
  for (let i = 0; i < 5; i++) A.ds.commit(withText(A.ds.project, "c1", `存 ${i}`));
  let written = null;
  const save = A.ds.whenSettled({ timeoutMs: 1000 }).then((s) => { written = { rev: s.rev, text: json(s.project) }; });
  await Promise.resolve();
  assert.equal(written, null); // 还没确认,不写
  svc.drain();
  await save;
  assert.equal(written.rev, svc.rev);
  assert.equal(written.text, json(svc.project));
  assertSame(svc, A, B);
});

test("V7-离线时保存:一直等,超时就报错", async () => {
  const { A } = setupClips();
  A.down();
  A.ds.commit(withText(A.ds.project, "c1", "x"));
  await assert.rejects(A.ds.whenSettled({ timeoutMs: 30 }), /超时/);
});

test("V7-没有未确认操作:立刻返回当前版本", async () => {
  const { svc, A } = setupClips();
  const s = await A.ds.whenSettled();
  assert.equal(s.rev, svc.rev);
});

/* ---------------- 其它协议细节 ---------------- */

test("文档服务还没有这个项目:用根替换把本地这份写进去", () => {
  const svc = new MemDocService();
  const A = page(svc, "A", clipsProject());
  A.ds.commit(withText(A.ds.project, "c1", "先改了"));
  svc.drain();
  assert.equal(svc.rev, 1);
  assert.deepEqual(svc.log[0].ops[0].path, "");
  assert.equal(textOf(svc.project, "c1"), "先改了");
  const B = page(svc, "B", clipsProject());
  svc.drain();
  assertSame(svc, A, B);
});

test("被拒(bad-path)的提交撤回本地、拿掉对应的撤销步", () => {
  const { svc, A, B } = setupClips();
  // B 删掉片段 1;A 还不知道,改了片段 1 的文字 —— A 的操作到文档服务时路径已不存在
  const b = structuredClone(B.ds.project);
  b.tracks[0].clips.splice(0, 1);
  B.ds.commit(b);
  A.ds.commit(withText(A.ds.project, "c1", "A1"));
  svc.handle(B.conn, B.conn.up.shift());
  svc.handle(A.conn, A.conn.up.shift());
  svc.drain();
  assert.ok(A.notices.some((n) => n.kind === "rejected" && n.reason === "bad-path"));
  assert.equal(A.ds.canUndo(), false);
  assertSame(svc, A, B);
});

/* ---------------- V8 ---------------- */

test("V8-1000 个片段的项目:页面提交一侧(差异 + 本地落地)≤ 5 ms,到另一页面看到变化", () => {
  const r = rng(8);
  const big = bigProject(r, 1000);
  const svc = new MemDocService({ project: structuredClone(big), rev: 1 });
  const A = page(svc, "A", structuredClone(big));
  const B = page(svc, "B", structuredClone(big));
  svc.drain();
  const times = [];
  const e2e = [];
  for (let i = 0; i < 40; i++) {
    const p = A.ds.project;
    const ti = i % 10;
    const next = { ...p, tracks: p.tracks.map((t, k) => (k === ti ? { ...t, clips: t.clips.map((c, j) => (j === 42 ? { ...c, start: c.start + 0.01, end: c.end + 0.01 } : c)) } : t)) };
    const t0 = performance.now();
    A.ds.commit(next);
    const t1 = performance.now();
    svc.drain();
    const t2 = performance.now();
    times.push(t1 - t0);
    e2e.push(t2 - t0);
  }
  times.sort((a, b) => a - b);
  e2e.sort((a, b) => a - b);
  const med = times[times.length >> 1];
  console.log(`V8 docsync 提交(1000 片段):median ${med.toFixed(3)} ms;经内存假件到 B:median ${e2e[e2e.length >> 1].toFixed(3)} ms`);
  assert.ok(med <= 5, `提交一侧 ${med} ms`);
  assertSame(svc, A, B);
});

test("V5-项目设置(name、fps 等顶层字段)同归 /meta 一个实体:别人改了 fps,我撤不回 name", () => {
  const { svc, A, B } = setupClips();
  A.ds.commit({ ...A.ds.project, name: "A 的名字" });
  svc.drain();
  B.ds.commit({ ...B.ds.project, fps: 60 });
  svc.drain();
  const res = A.ds.undo();
  assert.equal(res.done, false);
  assert.deepEqual(res.skipped.map((s) => [s.entity, s.by.session]), [["/meta", "B"]]);
  assertSame(svc, A, B);
});
