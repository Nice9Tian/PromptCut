/**
 * 账号办法的「搬到云端」流程(`accountMove.ts`)每一步的成功与失败。账号、文档连接、本机房间都用替身;
 * 对着真服务的在 `server/test/account-move.test.mjs`。跑:npm test -- src/editor/sync/accountMove.test.mjs
 *
 *   AM-01 本地项目搬上去:各步的先后;新建带的是占位内容与记下的请求号;做完记录删掉;结果里有项目链接
 *   AM-02 没登录:停在核对,什么都没发
 *   AM-03 建项目失败:名字重、名字不合法、账号不许建、不是账号模式的节点(都是没建成,记录作废);
 *         连不上、云端 5xx(结果不确定,请求号留着,再点一次原样重放,云端只建一个)
 *   AM-04 上一次结果不确定、这一次换了名字:先原样问清上一次;建成了就接着用它,确实没建成才用新名字另起
 *   AM-05 正文传到一半失败:本机没动、云端项目留着;再点一次不再新建,接着传,最后只有一个项目
 *   AM-06 读回来的内容对不上:停下,本机协作不关
 *   AM-07 内容超限:建项目之前就停
 *   AM-08 协作房间:不是创建者、没给创建者密码、密码不对都停在核对;成功时的先后(云端核对过才关本机协作);
 *         关不掉 → 本机仍是原房间;关的那一下内容又变了 → 补传;补传失败 → 本机协作已关、记录留着,之后从本地项目接着做
 *   AM-09 素材没拉齐:不关本机协作
 *   AM-10 传的过程中本机又改了:再传一轮,云端与本机相同;一直在改:传到轮数上限就失败(不报成功),本机没动
 *   AM-11 进项目:一时不通再试;几次都不行 → 记录留着;云端说项目没了 → 记录作废
 *   AM-12 素材缺:照样搬成,缺的名字在结果里
 *   AM-13 本机记录:存不下就不去建项目;结果不确定的记录过期后另起请求号;别的账号、别的项目的记录互不相干
 *   AM-14 「云端」指的是不是账号云端
 *   AM-15 内容比较:键的顺序、`undefined` 不算差别
 *   AM-16 失败的每一种都有一句话;本机没动的失败都说了本机没动
 *   AM-17 换过去的那一刻又改了:不换,补传后再进,云端与本机相同;连着改:失败,不报成功(协作房间这时本机已存盘)
 *   AM-18 本机协作关掉之后:先存本机再补传;补传失败时存下的是最新内容;存不下如实说;记下「这个房间是搬迁关的」
 *   AM-19 401 不作废请求号(云端可能已经落账);记录不过期
 *   AM-20 两个窗口:别的窗口正在搬就不动;各删各的记录(按请求号),占位过期后可以接手
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const M = await import("./accountMove.ts");

const PID = "sp_aaaaaaaaaaaaaaaaaaaaaaaaaa";
const PID2 = "sp_bbbbbbbbbbbbbbbbbbbbbbbbbb";
const ROOM = "sp_rrrrrrrrrrrrrrrrrrrrrrrrrr";
const project = (extra = {}) => ({ version: 1, id: "content-1", name: "片子", width: 1920, height: 1080, fps: 30, duration: 30, media: [], tracks: [{ id: "t-1", name: "序列 1", clips: [] }], ...extra });
const err = (status, code) => Object.assign(new Error(code), { status, code });

function memoryStorage() {
  const map = new Map();
  return { map, failWrites: false,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem(k, v) { if (this.failWrites) throw new Error("quota"); map.set(k, v); },
    removeItem: (k) => { map.delete(k); } };
}

function harness(o = {}) {
  const storage = o.storage ?? memoryStorage();
  const h = {
    storage, calls: [], stages: [],
    kind: o.kind ?? "local", creator: o.creator ?? true,
    account: "account" in o ? o.account : { id: "acc_000000000000000000000001", name: "甲" },
    local: o.local ?? project(),
    cloud: new Map(),          // projectId -> content
    names: new Map(),          // name -> projectId
    requests: new Map(),       // requestId -> { name, stub, projectId }
    nextId: [PID, PID2],
    createError: null, uploadError: null, readError: null, readOverride: null, enterErrors: [], closeResult: { ok: true }, checkResult: { ok: true },
    pull: { ok: true, missing: 0 }, media: { queued: 0, missing: [] }, roomOpen: (o.kind ?? "local") === "room", entered: null, saved: 0, seq: 0,
    onUpload: null, onClose: null,
  };
  h.attempts = M.createAttemptStore(storage);
  h.deps = {
    source: () => (h.entered ? null : h.roomOpen ? { kind: "room", contentId: h.local.id, creator: h.creator, roomId: ROOM } : { kind: "local", contentId: h.local.id }),
    account: async () => { h.calls.push("account"); if (h.accountError) throw h.accountError; return h.account; },
    create: async (name, stub, requestId) => {
      h.calls.push(`create:${name}:${requestId}`);
      const error = typeof h.createError === "function" ? h.createError({ name, stub, requestId }) : h.createError;
      if (error?.before) throw error.before;
      const prior = h.requests.get(requestId);
      if (prior) {
        assert.equal(JSON.stringify([prior.name, prior.stub]), JSON.stringify([name, stub]), "同一个请求号重放,内容必须一字不差");
        if (error?.after) throw error.after;
        return { projectId: prior.projectId };
      }
      if (h.names.has(name)) throw err(409, "name-taken");
      const projectId = h.nextId.shift();
      h.requests.set(requestId, { name, stub, projectId }); h.names.set(name, projectId); h.cloud.set(projectId, structuredClone(stub));
      if (error?.after) throw error.after;
      return { projectId };
    },
    snapshot: async () => { h.calls.push("snapshot"); if (h.snapshotError) throw h.snapshotError; return structuredClone(h.local); },
    current: () => h.local,
    upload: async (projectId, snapshot) => {
      h.calls.push("upload");
      if (h.uploadError) { const e = h.uploadError; if (h.uploadErrorOnce) h.uploadError = null; throw e; }
      h.cloud.set(projectId, structuredClone(snapshot));
      h.onUpload?.();
    },
    read: async (projectId) => { h.calls.push("read"); if (h.readError) throw h.readError; return h.readOverride ?? structuredClone(h.cloud.get(projectId)); },
    checkCreator: async (pw) => { h.calls.push(`check:${pw}`); return h.checkResult; },
    pullMedia: async () => { h.calls.push("pull"); return h.pull; },
    closeRoom: async (pw) => { h.calls.push(`close:${pw}`); if (h.closeResult.ok) { h.onClose?.(); h.roomOpen = false; } return h.closeResult; },
    saveLocal: async () => { h.calls.push("save"); if (h.saveError) throw h.saveError; h.saved++; h.savedContent = structuredClone(h.local); },
    // 真的接线在换过去的那一刻比内容(`enterAccountProject` 的 guard):不同就不换、抛 content-changed
    enter: async (x) => {
      h.calls.push("enter"); h.onEnter?.();
      const e = h.enterErrors.shift(); if (e) throw e;
      if (!M.sameContent(h.local, x.snapshot) || !M.sameContent(h.cloud.get(x.projectId), x.snapshot)) throw err(undefined, "content-changed");
      h.entered = x;
    },
    queueMedia: async () => { h.calls.push("queue"); return h.media; },
    attempts: h.attempts,
    newRequestId: () => `req-${++h.seq}`,
    stub: (name, contentId) => ({ version: 1, id: contentId, name, tracks: [], media: [] }),
    owner: o.owner ?? "window-1",
    linkOf: (projectId) => `https://cloud.test/editor?project=${projectId}`,
    onStage: (s) => h.stages.push(s),
    now: () => h.now ?? 1_000_000,
    sleep: async () => {},
  };
  h.move = (input = {}) => M.moveToAccountCloud(h.deps, { name: "片子", ...input });
  h.attempt = () => h.attempts.get(h.account.id, h.local.id);
  h.did = (prefix) => h.calls.filter((c) => c.startsWith(prefix)).length;
  return h;
}

test("AM-01 本地项目搬上去", async () => {
  const h = harness();
  const r = await h.move();
  assert.deepEqual(r, { ok: true, kind: "local", projectId: PID, name: "片子", link: `https://cloud.test/editor?project=${PID}`, media: { queued: 0, missing: [] } });
  assert.deepEqual(h.calls, ["account", "snapshot", "create:片子:req-1", "upload", "read", "save", "enter", "queue"]);
  assert.deepEqual(h.stages, ["check", "create", "upload", "verify", "enter", "queue-media", "done"]);
  assert.deepEqual(h.cloud.get(PID), h.local, "云端内容与本机一致");
  assert.deepEqual(h.requests.get("req-1").stub, { version: 1, id: "content-1", name: "片子", tracks: [], media: [] }, "新建带的是占位内容,不是项目正文");
  assert.equal(h.entered.projectId, PID);
  assert.equal(h.attempt(), null, "做完记录删掉");
  assert.equal(h.storage.map.size, 0);
});

test("AM-02 没登录:停在核对,什么都没发", async () => {
  const h = harness({ account: null });
  const r = await h.move();
  assert.deepEqual(r, { ok: false, error: "login-required", stage: "check", localClosed: false, cloud: null });
  assert.deepEqual(h.calls, ["account"]);
  assert.equal(h.storage.map.size, 0);
  // 登录接口回 401 同样算没登录;连不上是连不上
  const h2 = harness(); h2.accountError = err(401, "credential-revoked");
  assert.equal((await h2.move()).error, "login-required");
  const h3 = harness(); h3.accountError = err(0, "network");
  assert.equal((await h3.move()).error, "network");
  // 打开的不是能搬的东西
  const h4 = harness(); h4.entered = {};
  assert.equal((await h4.move()).error, "not-ready");
});

test("AM-03 建项目失败", async (t) => {
  await t.test("名字重:没建成,记录作废,本机没动", async () => {
    const h = harness(); h.names.set("片子", "sp_zzzzzzzzzzzzzzzzzzzzzzzzzz");
    const r = await h.move();
    assert.deepEqual(r, { ok: false, error: "name-taken", stage: "create", localClosed: false, cloud: null, detail: "name-taken" });
    assert.equal(h.attempt(), null);
    assert.equal(h.did("upload") + h.did("enter") + h.did("close"), 0);
    // 换个名字再点:新的请求号,建成
    const again = await h.move({ name: "片子 2" });
    assert.equal(again.ok, true); assert.equal(again.name, "片子 2");
    assert.equal(h.did("create"), 2);
  });
  for (const [status, code, expected] of [[400, "invalid-name", "invalid-name"], [403, "project-limit-reached", "create-refused"], [404, "no-route", "not-account-cloud"]]) {
    await t.test(`${status} ${code} → ${expected}:没建成,记录作废`, async () => {
      const h = harness(); h.createError = { before: err(status, code) };
      const r = await h.move();
      assert.equal(r.ok, false); assert.equal(r.error, expected); assert.equal(r.stage, "create"); assert.equal(r.cloud, null); assert.equal(r.localClosed, false);
      assert.equal(h.attempt(), null);
      assert.equal(h.cloud.size, 0);
    });
  }
  await t.test("名字是空的:不发请求", async () => {
    const h = harness();
    assert.equal((await h.move({ name: "   " })).error, "invalid-name");
    assert.equal(h.did("create"), 0);
  });
  await t.test("连不上(请求没到云端):请求号留着,再点一次原样重放,云端只有一个", async () => {
    const h = harness(); h.createError = { before: err(0, "network") };
    const r = await h.move();
    assert.equal(r.error, "network"); assert.equal(r.stage, "create"); assert.equal(r.cloud, null);
    assert.equal(h.attempt().requestId, "req-1"); assert.equal(h.attempt().projectId, undefined);
    h.createError = null;
    assert.equal((await h.move()).ok, true);
    assert.deepEqual(h.calls.filter((c) => c.startsWith("create")), ["create:片子:req-1", "create:片子:req-1"]);
    assert.equal(h.cloud.size, 1);
  });
  await t.test("云端 503(建成了但回包丢了):再点一次用同一个请求号拿回同一个项目,没有多出重名的", async () => {
    const h = harness(); h.createError = { after: err(503, "authority-unavailable") };
    const r = await h.move();
    assert.equal(r.error, "create-failed"); assert.equal(r.cloud, null);
    assert.equal(h.cloud.size, 1, "云端其实已经建了");
    h.createError = null;
    const again = await h.move();
    assert.equal(again.ok, true); assert.equal(again.projectId, PID);
    assert.equal(h.cloud.size, 1); assert.equal(h.names.size, 1);
    assert.deepEqual(h.cloud.get(PID), h.local);
  });
});

test("AM-04 上一次结果不确定、这一次换了名字", async (t) => {
  await t.test("上一次其实建成了:接着用它(名字是当时的),不另建", async () => {
    const h = harness(); h.createError = { after: err(0, "network") };
    assert.equal((await h.move({ name: "旧名" })).error, "network");
    h.createError = null;
    const r = await h.move({ name: "新名" });
    assert.equal(r.ok, true); assert.equal(r.name, "旧名"); assert.equal(r.projectId, PID);
    assert.equal(h.cloud.size, 1);
    assert.deepEqual(h.calls.filter((c) => c.startsWith("create")), ["create:旧名:req-1", "create:旧名:req-1"]);
  });
  await t.test("上一次确实没建成(那个名字后来被别人占了):用新名字另起一个请求号", async () => {
    const h = harness(); h.createError = { before: err(0, "network") };
    assert.equal((await h.move({ name: "旧名" })).error, "network");
    h.createError = null; h.names.set("旧名", "sp_zzzzzzzzzzzzzzzzzzzzzzzzzz");
    const r = await h.move({ name: "新名" });
    assert.equal(r.ok, true); assert.equal(r.name, "新名");
    assert.deepEqual(h.calls.filter((c) => c.startsWith("create")), ["create:旧名:req-1", "create:旧名:req-1", "create:新名:req-2"]);
    // 名字没换时,重名直接报给用户
    const h2 = harness(); h2.createError = { before: err(0, "network") };
    await h2.move({ name: "旧名" });
    h2.createError = null; h2.names.set("旧名", "sp_zzzzzzzzzzzzzzzzzzzzzzzzzz");
    assert.equal((await h2.move({ name: "旧名" })).error, "name-taken");
    assert.equal(h2.attempt(), null);
  });
  await t.test("问上一次时还是连不上:停下,不换请求号", async () => {
    const h = harness(); h.createError = { before: err(0, "network") };
    await h.move({ name: "旧名" });
    const r = await h.move({ name: "新名" });
    assert.equal(r.error, "network");
    assert.equal(h.attempt().requestId, "req-1");
    assert.equal(h.seq, 1);
  });
});

test("AM-05 正文传到一半失败:本机没动、云端项目留着;再点一次不再新建", async () => {
  const h = harness({ kind: "room" }); h.uploadError = err(undefined, "timeout");
  const r = await h.move({ creatorPassword: "pw" });
  assert.deepEqual(r, { ok: false, error: "upload-failed", stage: "upload", localClosed: false, cloud: { projectId: PID, name: "片子" }, detail: "timeout" });
  assert.equal(h.roomOpen, true, "本机协作没关");
  assert.equal(h.did("close") + h.did("pull") + h.did("enter") + h.did("save"), 0);
  assert.equal(h.attempt().projectId, PID);
  h.uploadError = null;
  const again = await h.move({ creatorPassword: "pw", name: "换了名字也不另建" });
  assert.equal(again.ok, true); assert.equal(again.projectId, PID); assert.equal(again.name, "片子");
  assert.equal(h.did("create"), 1, "新建只发过一次");
  assert.equal(h.cloud.size, 1);
  assert.equal(h.attempt(), null);
  // 传的时候云端说登录失效 / 项目没了
  const h2 = harness(); h2.uploadError = err(401, "credential-revoked");
  assert.equal((await h2.move()).error, "login-required");
  const h3 = harness(); h3.uploadError = err(404, "no-project");
  assert.equal((await h3.move()).error, "upload-failed");
  assert.equal(h3.attempt(), null, "云端项目没了:记录作废,下次重新建");
});

test("AM-06 读回来的内容对不上:停下,本机协作不关", async () => {
  const h = harness({ kind: "room" }); h.readOverride = project({ name: "不是这一份" });
  const r = await h.move({ creatorPassword: "pw" });
  assert.equal(r.error, "verify-failed"); assert.equal(r.stage, "verify"); assert.equal(r.detail, "content-mismatch"); assert.equal(r.localClosed, false);
  assert.equal(h.roomOpen, true); assert.equal(h.did("close") + h.did("enter"), 0);
  const h2 = harness(); h2.readError = err(0, "network");
  const r2 = await h2.move();
  assert.equal(r2.error, "verify-failed"); assert.equal(h2.did("enter"), 0);
});

test("AM-07 内容超限:建项目之前就停", async () => {
  const h = harness({ local: project({ note: "x".repeat(M.MAX_CONTENT_CHARS) }) });
  const r = await h.move();
  assert.equal(r.error, "too-large"); assert.equal(r.stage, "check"); assert.equal(r.cloud, null);
  assert.ok(Number(r.detail) > M.MAX_CONTENT_CHARS);
  assert.equal(h.did("create"), 0);
  assert.equal(h.storage.map.size, 0);
  assert.equal(M.MAX_CONTENT_CHARS, 64 * 128 * 1024);
});

test("AM-08 协作房间", async (t) => {
  await t.test("不是创建者、没给创建者密码、密码不对:停在核对", async () => {
    const a = harness({ kind: "room", creator: false });
    assert.equal((await a.move({ creatorPassword: "pw" })).error, "not-creator");
    const b = harness({ kind: "room" });
    assert.equal((await b.move()).error, "creator-password");
    const c = harness({ kind: "room" }); c.checkResult = { ok: false, error: "bad-password" };
    const r = await c.move({ creatorPassword: "错的" });
    assert.equal(r.error, "bad-password"); assert.equal(r.stage, "check");
    const d = harness({ kind: "room" }); d.checkResult = { ok: false, error: "rate-limited" };
    assert.equal((await d.move({ creatorPassword: "pw" })).error, "rate-limited");
    for (const h of [a, b, c, d]) { assert.equal(h.did("create") + h.did("snapshot") + h.did("close"), 0); assert.equal(h.roomOpen, true); }
  });
  await t.test("成功:云端核对过才关本机协作,关完才进项目", async () => {
    const h = harness({ kind: "room" });
    const r = await h.move({ creatorPassword: "pw" });
    assert.equal(r.ok, true); assert.equal(r.kind, "room");
    assert.deepEqual(h.calls, ["account", "check:pw", "snapshot", "create:片子:req-1", "upload", "read", "pull", "close:pw", "save", "enter", "queue"]);
    assert.deepEqual(h.stages, ["check", "create", "upload", "verify", "pull-media", "close-local", "enter", "queue-media", "done"]);
    assert.equal(h.roomOpen, false);
  });
  await t.test("关不掉:本机仍是原房间,不进项目;再点一次接着做", async () => {
    const h = harness({ kind: "room" }); h.closeResult = { ok: false, error: "pull-failed" };
    const r = await h.move({ creatorPassword: "pw" });
    assert.deepEqual(r, { ok: false, error: "close-failed", stage: "close-local", localClosed: false, cloud: { projectId: PID, name: "片子" }, detail: "pull-failed" });
    assert.equal(h.roomOpen, true); assert.equal(h.did("enter") + h.did("save"), 0);
    h.closeResult = { ok: false, error: "forbidden" };
    assert.equal((await h.move({ creatorPassword: "pw" })).error, "bad-password");
    h.closeResult = { ok: true };
    const again = await h.move({ creatorPassword: "pw" });
    assert.equal(again.ok, true); assert.equal(again.projectId, PID); assert.equal(h.did("create"), 1);
  });
  await t.test("关的那一下内容又变了:补传并核对,再进项目", async () => {
    const h = harness({ kind: "room" });
    h.onClose = () => { h.local = project({ name: "关之前别人刚改的" }); };
    const r = await h.move({ creatorPassword: "pw" });
    assert.equal(r.ok, true);
    assert.deepEqual(h.calls.slice(4), ["upload", "read", "pull", "close:pw", "save", "snapshot", "save", "upload", "read", "enter", "queue"]);
    assert.ok(h.stages.includes("sync-last"));
    assert.equal(h.cloud.get(PID).name, "关之前别人刚改的");
    assert.equal(h.entered.snapshot.name, "关之前别人刚改的");
  });
  await t.test("补传失败:本机协作已关、云端项目和记录都留着;之后从本地项目接着做", async () => {
    const h = harness({ kind: "room" });
    h.onClose = () => { h.local = project({ name: "最后的修改" }); h.uploadError = err(0, "network"); };
    const r = await h.move({ creatorPassword: "pw" });
    assert.deepEqual(r, { ok: false, error: "sync-last-failed", stage: "sync-last", localClosed: true, localSaved: true, cloud: { projectId: PID, name: "片子" }, detail: "network" });
    assert.equal(h.roomOpen, false); assert.equal(h.did("enter"), 0);
    assert.equal(h.savedContent.name, "最后的修改", "补传失败时,本机存下的已经是最新内容");
    assert.equal(h.attempt().projectId, PID);
    h.uploadError = null; h.calls.length = 0;
    const again = await h.move();
    assert.equal(again.ok, true); assert.equal(again.kind, "local"); assert.equal(again.projectId, PID);
    assert.deepEqual(h.calls, ["account", "snapshot", "upload", "read", "save", "enter", "queue"]);
    assert.equal(h.cloud.get(PID).name, "最后的修改");
    assert.equal(h.cloud.size, 1);
  });
});

test("AM-09 素材没拉齐:不关本机协作", async () => {
  const h = harness({ kind: "room" }); h.pull = { ok: false, missing: 3 };
  const r = await h.move({ creatorPassword: "pw" });
  assert.deepEqual(r, { ok: false, error: "media-pull-failed", stage: "pull-media", localClosed: false, cloud: { projectId: PID, name: "片子" }, detail: "3" });
  assert.equal(h.roomOpen, true); assert.equal(h.did("close") + h.did("enter"), 0);
});

test("AM-10 传的过程中本机又改了:再传一轮;一直在改就失败,不报成功", async () => {
  const h = harness();
  let edits = 0;
  h.onUpload = () => { if (edits < 1) { edits++; h.local = project({ name: "传的时候改的" }); } };
  const r = await h.move();
  assert.equal(r.ok, true);
  assert.equal(h.did("upload"), 2); assert.equal(h.did("snapshot"), 2);
  assert.deepEqual(h.cloud.get(PID), h.local, "云端与本机相同");
  assert.deepEqual(h.entered.snapshot, h.local);
  // 一直在改(每传一轮本机又变):到轮数上限就停,不关房间、不进项目、不报成功
  const busy = harness({ kind: "room" });
  let n = 0;
  busy.onUpload = () => { busy.local = project({ name: `一直在改 ${++n}` }); };
  const failed = await busy.move({ creatorPassword: "pw" });
  assert.deepEqual(failed, { ok: false, error: "busy-editing", stage: "verify", localClosed: false, cloud: { projectId: PID, name: "片子" } });
  assert.equal(busy.did("upload"), M.MAX_CONTENT_ROUNDS);
  assert.equal(busy.did("close") + busy.did("enter") + busy.did("save") + busy.did("pull"), 0, "本机没动");
  assert.equal(busy.roomOpen, true); assert.equal(busy.entered, null);
  assert.notDeepEqual(busy.cloud.get(PID), busy.local, "这时云端确实比本机旧,所以不能报成功");
  assert.equal(busy.attempt().projectId, PID, "停下来之后再点一次接着用同一个项目");
  busy.onUpload = null;
  const again = await busy.move({ creatorPassword: "pw" });
  assert.equal(again.ok, true); assert.deepEqual(busy.cloud.get(PID), busy.local); assert.equal(busy.did("create"), 1);
});

test("AM-11 进项目", async (t) => {
  await t.test("一时不通再试", async () => {
    const h = harness(); h.enterErrors = [err(503, "session-unavailable"), err(0, "network")];
    assert.equal((await h.move()).ok, true);
    assert.equal(h.did("enter"), 3);
  });
  await t.test("几次都不行:记录留着,再点一次接着进同一个项目", async () => {
    const h = harness(); h.enterErrors = [err(0, "network"), err(0, "network"), err(0, "network")];
    const r = await h.move();
    assert.equal(r.error, "enter-failed"); assert.equal(r.localClosed, false); assert.deepEqual(r.cloud, { projectId: PID, name: "片子" });
    assert.equal(h.did("enter"), M.ENTER_TRIES);
    assert.equal(h.attempt().projectId, PID);
    const again = await h.move();
    assert.equal(again.ok, true); assert.equal(again.projectId, PID); assert.equal(h.did("create"), 1);
  });
  await t.test("云端说项目没了:记录作废", async () => {
    const h = harness(); h.enterErrors = [err(404, "project-gone")];
    const r = await h.move();
    assert.equal(r.error, "enter-failed"); assert.equal(h.did("enter"), 1);
    assert.equal(h.attempt(), null);
  });
});

test("AM-12 素材缺:照样搬成,缺的名字在结果里", async () => {
  const h = harness(); h.media = { queued: 2, missing: ["丢了的.mp4"] };
  const r = await h.move();
  assert.equal(r.ok, true); assert.deepEqual(r.media, { queued: 2, missing: ["丢了的.mp4"] });
  const none = harness(); none.deps.queueMedia = async () => { throw new Error("no editor process"); };
  const r2 = await none.move();
  assert.equal(r2.ok, true); assert.equal(r2.media, null);
});

test("AM-13 本机记录", async (t) => {
  await t.test("存不下就不去建项目", async () => {
    const h = harness(); h.storage.failWrites = true;
    const r = await h.move();
    assert.equal(r.error, "not-ready"); assert.equal(r.stage, "create");
    assert.equal(h.did("create"), 0);
  });
  await t.test("记录不过期:隔了很久再点,还是原样重放那个请求号", async () => {
    const h = harness(); h.createError = { after: err(0, "network") };
    await h.move();
    h.createError = null; h.now = 1_000_000 + 365 * 24 * 3600_000;
    const r = await h.move();
    assert.equal(r.ok, true); assert.equal(r.projectId, PID);
    assert.deepEqual(h.calls.filter((c) => c.startsWith("create")), ["create:片子:req-1", "create:片子:req-1"]);
    assert.equal(h.cloud.size, 1, "没有留下第二个项目");
  });
  await t.test("别的账号、别的项目的记录互不相干;坏记录当没有", () => {
    const storage = memoryStorage(), store = M.createAttemptStore(storage);
    const a = { v: 1, accountId: "acc_1", contentId: "c1", requestId: "r1", name: "n", stub: {}, at: 1 };
    store.put(a); store.put({ ...a, accountId: "acc_2", requestId: "r2", projectId: PID });
    assert.equal(store.get("acc_1", "c1").requestId, "r1");
    assert.equal(store.get("acc_2", "c1").projectId, PID);
    assert.equal(store.get("acc_1", "c2"), null);
    store.drop("acc_1", "c1", "别人的请求号");
    assert.equal(store.get("acc_1", "c1").requestId, "r1", "请求号对不上不删");
    store.drop("acc_1", "c1", "r1");
    assert.equal(store.get("acc_1", "c1"), null); assert.equal(store.get("acc_2", "c1").requestId, "r2");
    store.drop("acc_2", "c1", "r2");
    assert.equal(storage.map.size, 0, "空了连键一起删");
    storage.map.set(M.MOVE_ATTEMPTS_KEY, "{not json");
    assert.equal(store.get("acc_1", "c1"), null);
    storage.map.set(M.MOVE_ATTEMPTS_KEY, JSON.stringify({ "acc_1|c1": { ...a, projectId: "不是项目号" } }));
    assert.equal(store.get("acc_1", "c1"), null);
    assert.equal(M.createAttemptStore(null).get("acc_1", "c1"), null);
  });
});

test("AM-14 「云端」指的是不是账号云端", () => {
  const account = "https://visuhive.com", builtin = "http://203.0.113.7:8787";
  const yes = (url) => assert.equal(M.isAccountCloudTarget(url, account, builtin), true, String(url));
  const no = (url) => assert.equal(M.isAccountCloudTarget(url, account, builtin), false, String(url));
  yes(""); yes(null); yes(undefined); yes("  ");
  yes("https://visuhive.com/hosted"); yes("wss://visuhive.com/hosted/"); yes("https://VISUHIVE.com");
  yes(builtin); yes("http://203.0.113.7:8787/"); yes("https://203-0-113-7.sslip.io/hosted");
  no("https://example.org/hosted"); no("http://127.0.0.1:8787"); no("https://visuhive.com.evil.test/hosted"); no("不是地址"); no("ftp://visuhive.com");
  // 夹具:账号云端在本机某个端口上,填的就是它
  assert.equal(M.isAccountCloudTarget("https://127.0.0.1:28956/hosted", "https://127.0.0.1:28956", builtin), true);
  assert.equal(M.isAccountCloudTarget("https://127.0.0.1:28957/hosted", "https://127.0.0.1:28956", builtin), false);
});

test("AM-15 内容比较:键的顺序、undefined 不算差别", () => {
  const a = { b: 1, a: [{ y: 2, x: undefined, z: null }], c: undefined };
  const b = JSON.parse(JSON.stringify({ a: [{ z: null, y: 2 }], b: 1 }));
  assert.equal(M.sameContent(a, b), true);
  assert.equal(M.contentText(a), '{"a":[{"y":2,"z":null}],"b":1}');
  assert.equal(M.sameContent(a, { ...b, b: 2 }), false);
  assert.equal(M.sameContent({ a: [1, 2] }, { a: [2, 1] }), false, "数组的顺序算差别");
  assert.equal(M.sameContent([undefined], [null]), true, "数组里的 undefined 在 JSON 里就是 null");
});

test("AM-16 失败的每一种都有一句话;本机没动的失败都说了本机没动", () => {
  const codes = ["busy", "busy-editing", "login-required", "not-ready", "not-creator", "creator-password", "bad-password", "rate-limited", "save-pending", "too-large", "name-taken", "invalid-name",
    "create-refused", "not-account-cloud", "network", "create-failed", "upload-failed", "verify-failed", "media-pull-failed", "close-failed", "sync-last-failed", "enter-failed"];
  const seen = new Set();
  for (const error of codes) for (const kind of ["local", "room"]) {
    const closed = error === "sync-last-failed";
    const text = M.moveFailureText({ ok: false, error, stage: "create", localClosed: closed, ...(closed ? { localSaved: true } : {}), cloud: { projectId: PID, name: "片子" }, detail: "3" }, kind);
    assert.equal(typeof text, "string"); assert.ok(text.length > 6, error);
    seen.add(text);
    const says = /本机项目没有改动|本机协作没有改动|仍是原来的房间/.test(text);
    if (["busy-editing", "not-ready", "bad-password", "rate-limited", "save-pending", "too-large", "name-taken", "invalid-name", "create-refused", "not-account-cloud", "network", "create-failed", "upload-failed", "verify-failed"].includes(error)) assert.ok(says, `${error}/${kind}: ${text}`);
    if (error === "close-failed") assert.match(text, /仍是原来的房间/);
    if (error === "sync-last-failed") { assert.match(text, /本机协作已关闭/); assert.match(text, /最新内容已存在本机这份文件里/); assert.match(text, /缺最后的几处修改/); assert.ok(!says); }
    if (error === "busy-editing") assert.match(text, /先让它停下/);
  }
  assert.ok(seen.size >= codes.length);
  for (const stage of ["check", "create", "upload", "verify", "pull-media", "close-local", "sync-last", "enter", "queue-media", "done"]) assert.match(M.ACCOUNT_MOVE_TEXT.stage[stage], /^正在搬到云端/);
});

test("AM-17 换过去的那一刻又改了:不换,补传后再进;连着改就失败", async (t) => {
  await t.test("本地项目:最后一次比对之后、换过去之前改了一处", async () => {
    const h = harness();
    let once = true;
    h.onEnter = () => { if (once) { once = false; h.local = project({ name: "进项目前一刻改的" }); } };
    const r = await h.move();
    assert.equal(r.ok, true);
    assert.equal(h.did("enter"), 2, "第一次没有换过去");
    assert.deepEqual(h.cloud.get(PID), h.local, "云端与本机相同");
    assert.deepEqual(h.entered.snapshot, h.local);
    assert.equal(h.savedContent.name, "进项目前一刻改的", "本机那一份存的也是最新的");
    assert.deepEqual(h.calls.slice(-8), ["save", "enter", "snapshot", "upload", "read", "save", "enter", "queue"]);
  });
  await t.test("本地项目:每次要换过去时都在改 → 失败,编辑器没有换,本机内容还在", async () => {
    const h = harness();
    let n = 0;
    h.onEnter = () => { h.local = project({ name: `连着改 ${++n}` }); };
    const r = await h.move();
    assert.equal(r.ok, false); assert.equal(r.error, "busy-editing"); assert.equal(r.localClosed, false);
    assert.equal(h.entered, null, "没有换到云端项目");
    assert.equal(h.did("queue"), 0);
    assert.equal(h.attempt().projectId, PID);
    assert.match(M.moveFailureText(r, "local"), /一直在被修改.*本机项目没有改动.*先让它停下/);
  });
  await t.test("协作房间:关掉之后连着改 → 失败,本机协作已关、最新内容已存本机,之后从本地项目补上", async () => {
    const h = harness({ kind: "room" });
    let n = 0;
    h.onEnter = () => { h.local = project({ name: `关了以后还在改 ${++n}` }); };
    const r = await h.move({ creatorPassword: "pw" });
    assert.equal(r.ok, false); assert.equal(r.error, "busy-editing"); assert.equal(r.localClosed, true); assert.equal(r.localSaved, true);
    assert.equal(h.entered, null);
    assert.match(M.moveFailureText(r, "room"), /本机协作已关闭.*最新内容已存在本机这份文件里/);
    h.onEnter = null; h.calls.length = 0;
    // 再点一次时照当前内容补(这时是本地项目,用原来的请求号)
    const again = await h.move();
    assert.equal(again.ok, true); assert.equal(again.kind, "local"); assert.equal(again.projectId, PID);
    assert.equal(h.did("create"), 0);
    assert.deepEqual(h.cloud.get(PID), h.local);
  });
  await t.test("云端内容被别人动过(换过去时云端与核对过的不同):同样不换", async () => {
    const h = harness();
    h.onEnter = () => { h.cloud.set(PID, project({ name: "云端被动过" })); };
    const r = await h.move();
    assert.equal(r.ok, false); assert.equal(r.error, "busy-editing"); assert.equal(h.entered, null);
  });
});

test("AM-18 本机协作关掉之后:先存本机再补传", async (t) => {
  await t.test("关完第一件事是存本机;记下这个房间是搬迁关的", async () => {
    const h = harness({ kind: "room" });
    const r = await h.move({ creatorPassword: "pw" });
    assert.equal(r.ok, true);
    const i = h.calls.indexOf("close:pw");
    assert.equal(h.calls[i + 1], "save", "关掉本机协作后立刻存本机");
    assert.equal(h.saved, 1, "内容没变就只存一次");
    assert.equal(h.attempts.isMovedRoom(ROOM), true);
    assert.equal(h.attempts.isMovedRoom("sp_xxxxxxxxxxxxxxxxxxxxxxxxxx"), false);
  });
  await t.test("关的那一下内容变了、补传失败:存下的是最新内容,结果里写着已存", async () => {
    const h = harness({ kind: "room" });
    h.onClose = () => { h.local = project({ name: "最后的修改" }); h.uploadError = err(0, "network"); };
    const r = await h.move({ creatorPassword: "pw" });
    assert.equal(r.error, "sync-last-failed"); assert.equal(r.localClosed, true); assert.equal(r.localSaved, true);
    assert.ok(h.calls.lastIndexOf("save") < h.calls.lastIndexOf("upload"), "先存本机、后补传");
    assert.deepEqual(h.savedContent, h.local);
    assert.match(M.moveFailureText(r, "room"), /本机协作已关闭，最新内容已存在本机这份文件里；云端项目已建好，但缺最后的几处修改。再补一次/);
  });
  await t.test("存不下:如实说,不说已存", async () => {
    const h = harness({ kind: "room" });
    h.onClose = () => { h.local = project({ name: "最后的修改" }); h.uploadError = err(0, "network"); h.saveError = new Error("disk full"); };
    const r = await h.move({ creatorPassword: "pw" });
    assert.equal(r.error, "sync-last-failed"); assert.equal(r.localSaved, false);
    assert.match(M.moveFailureText(r, "room"), /没能存到本机文件，请先手动保存/);
  });
  await t.test("关不掉:不存本机(本机还是原来的房间)", async () => {
    const h = harness({ kind: "room" }); h.closeResult = { ok: false, error: "offline" };
    const r = await h.move({ creatorPassword: "pw" });
    assert.equal(r.error, "close-failed"); assert.equal(r.localClosed, false); assert.equal("localSaved" in r, false);
    assert.equal(h.did("save"), 0);
  });
});

test("AM-19 401 不作废请求号;4xx 里只有四种算肯定没建成", async () => {
  // 云端先落账、初始化完再核登录:这时回 401,项目其实已经建了
  const h = harness(); h.createError = { after: err(401, "credential-revoked") };
  const r = await h.move();
  assert.equal(r.error, "login-required"); assert.equal(r.stage, "create");
  assert.equal(h.cloud.size, 1, "云端已经建了");
  assert.equal(h.attempt().requestId, "req-1", "请求号留着"); assert.equal(h.attempt().projectId, undefined);
  h.createError = null;
  const again = await h.move({ name: "重新登录后换了名字" });
  assert.equal(again.ok, true); assert.equal(again.projectId, PID); assert.equal(again.name, "片子");
  assert.equal(h.cloud.size, 1); assert.equal(h.names.size, 1, "没有对着自己看不见的项目报重名,也没有多建");
  for (const [status, code] of [[409, "request-mismatch"], [413, "body-too-large"], [429, "rate-limited"], [400, "bad-request-id"]]) {
    const k = harness(); k.createError = { before: err(status, code) };
    const f = await k.move();
    assert.equal(f.ok, false);
    assert.equal(k.attempt()?.requestId, "req-1", `${status} ${code} 不作废`);
  }
});

test("AM-20 两个窗口", async (t) => {
  await t.test("别的窗口正在搬:这个窗口不动", async () => {
    const storage = memoryStorage();
    const a = harness({ storage, owner: "window-a" }), b = harness({ storage, owner: "window-b" });
    let bResult = null;
    // 甲传内容的时候乙点了搬
    a.deps.upload = async (projectId, snapshot) => { a.calls.push("upload"); bResult = await b.move(); a.cloud.set(projectId, structuredClone(snapshot)); };
    const r = await a.move();
    assert.equal(r.ok, true);
    assert.deepEqual(bResult, { ok: false, error: "busy", stage: "check", localClosed: false, cloud: null });
    assert.deepEqual(b.calls, ["account"], "乙什么都没发");
    assert.match(M.moveFailureText(bResult, "local"), /另一个窗口正在搬/);
    assert.equal(storage.map.has(M.MOVE_LOCKS_KEY), false, "甲做完,占位放掉");
  });
  await t.test("占位过期(那个窗口不在了)可以接手;没过期不行", () => {
    const store = M.createAttemptStore(memoryStorage());
    assert.equal(store.lock("acc", "c", "w1", 1000), true);
    assert.equal(store.lock("acc", "c", "w2", 1000 + M.LOCK_STALE_MS - 1), false);
    assert.equal(store.lock("acc", "c", "w1", 2000), true, "自己续");
    assert.equal(store.lock("acc", "c", "w2", 2000 + M.LOCK_STALE_MS), true, "过期后接手");
    store.unlock("acc", "c", "w1");
    assert.equal(store.lock("acc", "c", "w3", 2000 + M.LOCK_STALE_MS + 1), false, "别人的占位放不掉");
    store.unlock("acc", "c", "w2");
    assert.equal(store.lock("acc", "c", "w3", 2000 + M.LOCK_STALE_MS + 1), true);
  });
  await t.test("乙接着用甲那次建好的项目,不另建;甲的记录还在(按请求号删)", async () => {
    const storage = memoryStorage();
    const a = harness({ storage, owner: "window-a" }); a.uploadError = err(0, "network");
    await a.move();
    assert.equal(a.attempt().projectId, PID);
    const b = harness({ storage, owner: "window-b" }); b.cloud = a.cloud; b.requests = a.requests; b.names = a.names; b.uploadError = err(0, "network");
    const r = await b.move({ name: "乙填的名字" });
    assert.equal(r.error, "upload-failed"); assert.equal(r.cloud.projectId, PID);
    assert.equal(a.attempt().requestId, "req-1");
    assert.equal(b.did("create"), 0);
  });
});
