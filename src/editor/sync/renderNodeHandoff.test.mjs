/**
 * 桌面应用自动成为共享项目的渲染节点:页面一侧(`renderNodeHandoff.ts`)。报告 `docs/reports/AGENT-desktop-auto-node.md`。
 * 跑:node --test src/editor/sync/renderNodeHandoff.test.mjs
 *
 *   RNH-01 接上共享项目:交共享配置,带本页面签的 render 票据;同一个项目重复接不再交
 *   RNH-02 项目文档 id 晚到、素材基址挑到:同一个项目再交一次,不另签票据
 *   RNH-03 票据往返:只答本页面连着的那个项目;签不出就交回错误
 *   RNH-04 离开:只撤同一个项目的;撤完再有票据请求不答
 */
import "../../testing/registerTs.mjs";
import test from "node:test";
import assert from "node:assert/strict";

const H = await import("./renderNodeHandoff.ts");
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0)); };

const posts = [];
H.setRenderNodeDeps({ post: async (path, body) => { posts.push({ path, body }); return { ok: true }; } });
let signed = 0;
let refuse = false;
const hooks = { ticket: async (projectId) => { if (refuse) throw new Error("本页面没有连着这个共享项目"); signed++; return `v1.t${signed}-${projectId}.s`; } };
const B = { url: "wss://site.example/hosted/", projectId: "P1", contentId: "doc-1" };

test("RNH-01 接上共享项目:交共享配置与票据;重复接不再交", async () => {
  H.bindRenderNode(B, hooks);
  await flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/api/render-node/bind");
  assert.deepEqual(posts[0].body, { url: B.url, projectId: "P1", contentId: "doc-1", ticket: "v1.t1-P1.s" });
  H.bindRenderNode({ ...B }, hooks);
  await flush();
  assert.equal(posts.length, 1);
  assert.deepEqual(H.renderNodeHandoffDiag().bound, { url: B.url, projectId: "P1", contentId: "doc-1" });
  assert.ok(!JSON.stringify(H.renderNodeHandoffDiag()).includes("v1.t1"), "诊断里不带票据");
});

test("RNH-02 文档 id 晚到、素材基址挑到:再交一次,不另签票据", async () => {
  const before = signed;
  H.bindRenderNode({ ...B, contentId: "doc-2" }, hooks);
  await flush();
  assert.deepEqual(posts.at(-1).body, { url: B.url, projectId: "P1", contentId: "doc-2" });
  H.noteRenderNodeAssetBase("https://site.example/media/api/asset/");
  await flush();
  assert.deepEqual(posts.at(-1).body, { url: B.url, projectId: "P1", contentId: "doc-2", assetBase: "https://site.example/media/api/asset" });
  const n = posts.length;
  H.noteRenderNodeAssetBase("https://site.example/media/api/asset");
  H.noteRenderNodeAssetBase(null); // 本机当主机:不交(预渲染进程推本机的)
  await flush();
  assert.equal(posts.length, n);
  assert.equal(signed, before, "没有另签票据");
});

test("RNH-03 票据往返:只答本页面连着的项目", async () => {
  const n = posts.length;
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn1", projectId: "OTHER" });
  assert.equal(posts.length, n, "别的项目不答");
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn2", projectId: "P1" });
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/ticket", body: { reqId: "rn2", ticket: `v1.t${signed}-P1.s` } });
  refuse = true;
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn3", projectId: "P1" });
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/ticket", body: { reqId: "rn3", error: "本页面没有连着这个共享项目" } });
  refuse = false;
});

test("RNH-04 离开:只撤同一个项目的", async () => {
  const n = posts.length;
  H.unbindRenderNode("OTHER");
  await flush();
  assert.equal(posts.length, n);
  H.unbindRenderNode("P1", "left");
  await flush();
  assert.deepEqual(posts.at(-1), { path: "/api/render-node/unbind", body: { projectId: "P1", reason: "left" } });
  assert.equal(H.renderNodeHandoffDiag().bound, null);
  const m = posts.length;
  await H.answerRenderNodeTicket({ type: "ticket", reqId: "rn4", projectId: "P1" });
  H.unbindRenderNode("P1");
  await flush();
  assert.equal(posts.length, m, "撤完不再答票据、不重复撤");
  // 再接别的项目:重新签票据交接
  H.bindRenderNode({ url: "ws://192.168.1.5:5190/docservice", projectId: "P2", contentId: "doc-9" }, hooks);
  await flush();
  assert.equal(posts.at(-1).path, "/api/render-node/bind");
  assert.equal(posts.at(-1).body.projectId, "P2");
  assert.match(posts.at(-1).body.ticket, /-P2\.s$/);
});
