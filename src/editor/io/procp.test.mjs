// .procp 打包件:zip 字节格式、首条目、按哈希去重、以及别的 zip 工具压出来的 deflate 条目。
//   node --test src/editor/io/procp.test.mjs
//
// procp.ts 顶上只有类型 import(store 和 proc.ts 都是函数里动态 import 的),
// 所以这里可以直接加载它;装包本体是 packProcpFrom(procText, project),不碰 store。
// 服务端那一侧(本地内容库)用一个假的 fetch 顶上:内容按 sha256 入库,和
// server/vite-plugin-media.ts 的 storeMediaStream 是同一套规矩。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";

const { packProcpFrom, unpackProcp, readZip, inflate, isProcpFile, PROCP_EXT } = await import("./procp.ts");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** 假的本地内容库 + 假 fetch:只认 procp.ts 用到的那三条路由 */
function fakeStore() {
  /** hash -> {bytes, ext} */
  const store = new Map();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    const u = String(url);
    if (u.startsWith("/@media/")) {
      const hash = u.slice("/@media/".length).split(".")[0].toLowerCase();
      const hit = store.get(hash);
      if (!hit) return new Response(null, { status: 404 });
      return new Response(hit.bytes, { status: 200 });
    }
    if (u.startsWith("/api/media/local")) {
      const asked = (new URL(u, "http://x").searchParams.get("hashes") || "").split(",").filter(Boolean);
      return Response.json({ ok: true, hashes: asked.filter((h) => store.has(h)) });
    }
    if (u.startsWith("/api/media/upload/")) {
      const name = decodeURIComponent(u.slice("/api/media/upload/".length));
      const bytes = Buffer.from(await new Response(init.body).arrayBuffer());
      // 服务端按**内容**定键,包里条目名写错也污染不了库
      const hash = sha256(bytes);
      const deduped = store.has(hash);
      if (!deduped) store.set(hash, { bytes, ext: (name.split(".").pop() || "").toLowerCase() });
      return Response.json({ ok: true, hash, url: `/@media/${hash}`, bytes: bytes.length, deduped });
    }
    throw new Error(`假 fetch 不认识这条路由: ${u}`);
  };
  return {
    store,
    put(bytes, ext) {
      const hash = sha256(bytes);
      store.set(hash, { bytes, ext });
      return hash;
    },
    restore() { globalThis.fetch = realFetch; },
  };
}

const CLIP_A = Buffer.from("fake-mp4-bytes-A-".repeat(40));
const CLIP_B = Buffer.from("fake-png-bytes-B-".repeat(31));
const PROC_TEXT = JSON.stringify({ format: "promptcut-project", version: 1, project: { name: "包测试" } });

function projectWith(hashA, hashB) {
  return {
    name: "包测试",
    media: [
      { id: "m1", kind: "video", name: "a.mp4", ext: "mp4", hash: hashA, url: `/@media/${hashA}` },
      { id: "m2", kind: "image", name: "b.png", ext: "png", hash: hashB, url: `/@media/${hashB}` },
      // 同一份素材被第二条记录引用:包里只该有一份字节
      { id: "m3", kind: "video", name: "a-copy.mp4", ext: "mp4", hash: hashA, url: `/@media/${hashA}` },
      // 迁移期的老素材:没有 hash,装不进包(也不该让整次打包失败)
      { id: "m4", kind: "video", name: "legacy.mp4", url: "/@media/legacy.mp4" },
    ],
  };
}

test("装包:首条目是 project.proc,素材按 <hash>.<ext> 且按哈希去重", async () => {
  const fake = fakeStore();
  try {
    const hashA = fake.put(CLIP_A, "mp4");
    const hashB = fake.put(CLIP_B, "png");
    const blob = await packProcpFrom(PROC_TEXT, projectWith(hashA, hashB));

    const entries = await readZip(blob);
    assert.equal(entries[0].name, "project.proc", "第一个条目一定是编排,不解压也能 head 出来");
    assert.deepEqual(entries.map((e) => e.name).slice(1).sort(), [`media/${hashA}.mp4`, `media/${hashB}.png`]);
    assert.equal(entries.length, 3, "m3 和 m1 同哈希只装一份;m4 没有哈希,跳过");
    assert.equal(await (await inflate(entries[0])).text(), PROC_TEXT);

    const back = new Map();
    for (const e of entries.slice(1)) back.set(e.name, Buffer.from(await (await inflate(e)).arrayBuffer()));
    assert.equal(back.get(`media/${hashA}.mp4`).equals(CLIP_A), true);
    assert.equal(back.get(`media/${hashB}.png`).equals(CLIP_B), true);

    // 包自己也认得出是包(名字没了也靠 PK\x03\x04)
    assert.equal(await isProcpFile(blob), true);
    assert.equal(await isProcpFile(new Blob([PROC_TEXT])), false);
    assert.equal(await isProcpFile(Object.assign(new Blob([PROC_TEXT]), { name: `x${PROCP_EXT}` })), true);
  } finally {
    fake.restore();
  }
});

test("往返:拆到空库里是新写两份,再拆一次全是去重", async () => {
  const packer = fakeStore();
  let blob;
  let hashA;
  let hashB;
  try {
    hashA = packer.put(CLIP_A, "mp4");
    hashB = packer.put(CLIP_B, "png");
    blob = await packProcpFrom(PROC_TEXT, projectWith(hashA, hashB));
  } finally {
    packer.restore();
  }

  // 另一台机器:内容库是空的
  const other = fakeStore();
  try {
    const first = await unpackProcp(blob);
    assert.equal(first.procText, PROC_TEXT);
    assert.equal(first.stored, 2);
    assert.equal(first.deduped, 0);
    assert.equal(other.store.get(hashA).bytes.equals(CLIP_A), true);
    assert.equal(other.store.get(hashB).bytes.equals(CLIP_B), true);

    // 同一个包再拆一次:一份字节都不再传
    const again = await unpackProcp(blob);
    assert.equal(again.stored, 0);
    assert.equal(again.deduped, 2);
    assert.equal(other.store.size, 2);
  } finally {
    other.restore();
  }
});

test("别的 zip 工具压出来的 deflate 条目也读得了", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pc-procp-"));
  try {
    const text = "PromptCut .procp deflate fixture\n".repeat(400); // 够重复,一定会被压
    const src = path.join(dir, "project.proc");
    const zip = path.join(dir, "made-by-powershell.zip");
    fs.writeFileSync(src, text);
    try {
      execFileSync("powershell.exe", ["-NoProfile", "-Command", `Compress-Archive -Path '${src}' -DestinationPath '${zip}' -Force`], { stdio: "pipe" });
    } catch (err) {
      t.skip(`这台机器上跑不了 Compress-Archive: ${err.message}`);
      return;
    }
    const blob = new Blob([fs.readFileSync(zip)]);
    assert.equal(await isProcpFile(blob), true);
    const entries = await readZip(blob);
    const proc = entries.find((e) => e.name === "project.proc");
    assert.ok(proc, "PowerShell 压的包里应当有 project.proc");
    assert.equal(proc.method, 8, "Compress-Archive 用的是 deflate,正好验到 method 8 那条路");
    assert.equal(await (await inflate(proc)).text(), text);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
