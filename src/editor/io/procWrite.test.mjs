/**
 * `.proc` 写盘那一步(`proc.ts` 的 `writeProcToDisk`):收预渲染快照、写临时副本、出错不碰原文件。
 * 跑:node --experimental-test-module-mocks --test src/editor/io/procWrite.test.mjs
 *
 * 钉死:
 *   - 渲染(预渲染快照)等到时限还没收到:项目照存(快照是可丢的缓存),但结果里标出这次没带快照、保存流程告诉用户 —— 不静默放过;
 *
 * 文件句柄是假的:`createWritable` 回的流照浏览器的规矩办(写进临时副本,`close` 才替换原文件,`abort` 丢掉临时副本)。
 * 真浏览器里这条规矩成不成立由探针 `scripts/probes/save-state-probe.mjs --phases fail` 验。
 */
import { srcUrl } from "../../testing/registerTs.mjs";
import test, { mock } from "node:test";
import assert from "node:assert/strict";

/** 预渲染快照这次怎么回:ok 立刻回;hang 一直不回(等到时限) */
let archiveMode = "ok";
mock.module(srcUrl("render/frameClient.ts"), {
  namedExports: {
    snapshotsFor: () => undefined,
    restoreSnapshots: () => {},
    frameRequest: (op, project, extra, signal) => {
      if (archiveMode === "ok") return Promise.resolve({ snapshots: "SNAP" });
      return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(new Error("帧读取失败")), { once: true }));
    },
  },
});

/** 照浏览器规矩办的假文件:内容在 `bytes`,流写进临时副本 */
function fakeFile(name, initial = "") {
  const file = { name, kind: "file", bytes: initial, swaps: 0, log: [] };
  file.createWritable = async () => {
    let swap = "";
    let open = true;
    file.swaps += 1;
    return {
      write: async (data) => {
        if (!open) throw new Error("流已关闭");
        swap += typeof data === "string" ? data : await data.text();
        if (file.failAfterHalf) { file.log.push("write-failed"); throw new Error(file.failAfterHalf); }
      },
      close: async () => { if (!open) throw new Error("流已关闭"); open = false; file.bytes = swap; file.swaps -= 1; file.log.push("close"); },
      abort: async () => { open = false; file.swaps -= 1; file.log.push("abort"); },
    };
  };
  return file;
}

let target = null;
globalThis.window = Object.assign(new EventTarget(), {
  showSaveFilePicker: async () => target,
});

const proc = await import(srcUrl("editor/io/proc.ts"));
const { saveProcFile } = await import(srcUrl("editor/io/saveFlow.ts"));
const { actions, getState } = await import(srcUrl("store/project.ts"));

function saveDeps(notes) {
  return {
    writeProc: (produce, fileName) => proc.writeProcToDisk(produce, fileName),
    settle: async () => {},
    serialize: () => proc.serializeProc(),
    saveDraft: async () => {},
    markSaved: (f) => actions.markSaved(f),
    notify: (m, tone = "error") => notes.push({ m, tone }),
    currentProject: () => getState().project,
    waitTimeoutMs: 2000,
  };
}

test("预渲染快照收到了:随文件存进去,不另行提示", async () => {
  archiveMode = "ok";
  proc.forgetSaveTarget();
  target = fakeFile("快照.proc");
  actions.newProject("快照");
  const notes = [];
  assert.equal(await saveProcFile("快照.proc", saveDeps(notes)), "saved");
  assert.equal(JSON.parse(target.bytes).snapshots, "SNAP");
  assert.deepEqual(notes, []);
});

test("预渲染快照等到时限没收到:项目照存(不带快照),结果里标出来,并告诉用户", async () => {
  archiveMode = "hang";
  proc.forgetSaveTarget();
  target = fakeFile("快照超时.proc");
  actions.newProject("快照超时");
  const outcome = await proc.writeProcToDisk(async () => proc.serializeProc(), "快照超时.proc");
  assert.equal(outcome.kind, "saved");
  assert.equal(outcome.snapshotsSkipped, true, "结果里标出这次没带快照");
  const doc = JSON.parse(target.bytes);
  assert.equal(doc.project.name, "快照超时", "项目内容照存");
  assert.equal(doc.snapshots, undefined);

  proc.forgetSaveTarget();
  target = fakeFile("快照超时2.proc");
  const notes = [];
  assert.equal(await saveProcFile("快照超时2.proc", saveDeps(notes)), "saved");
  assert.equal(notes.length, 1);
  assert.equal(notes[0].tone, "info");
  assert.match(notes[0].m, /预渲染快照/);
  assert.equal(getState().dirty, false, "项目内容完整,算保存了");
  archiveMode = "ok";
});
