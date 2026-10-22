/**
 * 在线上传队列 × 游客视频条数（2026-10-23 用户定「总视频素材不能大于三条」）：真的队列（`mediaUploadQueue.ts`）
 * 对着真的素材服务（`server/asset-service.ts` + 项目数据层 fs，合成的文档服务权威，主体是游客）。
 *
 * 覆盖：
 * - 云端账号项目的每一片带 `X-Media-Tier`（小档 `small`、原尺寸 `original`）；不是账号项目的不带
 *   （本地项目经托管中继，预检放行的头里没有它，带上浏览器会把整个 PUT 拦了）；
 * - 游客经队列传 3 个视频（6 个文件）全部入库，第 4 个视频的小档进去、原尺寸被拒、这一项不出队。
 *   改之前的那一版（按文件数 3 条）在第 2 个视频的原尺寸就拒了 —— 这条测试守的就是这个。
 */
import "../testing/registerTs.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import crypto from "node:crypto";
import path from "node:path";
import os from "node:os";
import fsp from "node:fs/promises";

const { createMediaUploadQueue } = await import("./mediaUploadQueue.ts");
const { compileAssetModules } = await import("../../server/test/fixtures/asset-project-service.mjs");
const { createProjectAssetStores } = await import("../../server/asset-store/project-stores.mjs");
const { createProjectAssetAccess } = await import("../../server/asset-store/project-access.mjs");

const GUEST = "gst_" + "0123456789abcdef01234567";
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
const tierOf = (label, tier) => {
  const bytes = Buffer.from(`queue guest ${label} ${tier} ${crypto.randomUUID()}`);
  return { tier, hash: sha(bytes), ext: "mp4", blob: new Blob([bytes]) };
};
const videoItem = (label) => ({ id: `v-${label}`, name: `${label}.mp4`, tiers: [tierOf(label, "small"), tierOf(label, "original")] });

const out = await fsp.mkdtemp(path.join(os.tmpdir(), "pc-queue-guest-"));
after(() => fsp.rm(out, { recursive: true, force: true }));
const { asset, media } = await compileAssetModules(out);

/** 票据就是项目编号；主体一律是那个游客 */
const principalOf = (token) => (/^[A-Za-z0-9-]+$/.test(String(token ?? ""))
  ? { projectId: token, access: "rw", accountId: GUEST, loginId: `l-${GUEST}`, credentialId: `c-${GUEST}`, authorizationId: `auth-${token}` }
  : null);
const authority = {
  async checkAccess({ principal, projectId }) { return { allowed: principal?.projectId === projectId, accessRevision: 1, revocationSeq: 0 }; },
  subscribeRevocations() { return () => {}; },
};
const projectAccess = createProjectAssetAccess({ authority, resolvePrincipal: async (req) => principalOf(/^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ""))?.[1]) });
const factory = createProjectAssetStores({ dir: path.join(out, "assets"), contentTypeForExt: media.contentTypeForExt });
const handler = asset.assetServiceMiddleware(out, { projectStores: factory, projectAccess, pullArtifact: null, pxEvict: null });
const server = http.createServer((req, res) => { void handler(req, res, () => { res.statusCode = 404; res.end("no route"); }); });
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => { server.closeAllConnections?.(); server.close(); });
const base = `http://127.0.0.1:${server.address().port}/api/asset`;

/** 记下每一次 PUT 带的档位头 */
function recording() {
  const puts = [];
  const f = async (url, init = {}) => {
    if (init.method === "PUT") puts.push({ hash: /\/media\/([0-9a-f]{64})\//.exec(String(url))?.[1], tier: (init.headers ?? {})["X-Media-Tier"] });
    return fetch(url, init);
  };
  return { puts, fetch: f };
}

async function runQueue(items, target) {
  const rec = recording();
  const events = [];
  const q = createMediaUploadQueue({ target: () => target, fetch: rec.fetch, backoff: [60_000], log: (event, fields) => events.push({ event, ...fields }) });
  for (const it of items) assert.equal((await q.enqueue(it)).queued, true);
  q.start();
  // 等到每一项要么出队、要么失败过一次（失败的进退避，60 秒内不会再试）
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const s = q.stats();
    if (s.done + s.failures >= items.length && !s.working) break;
    await new Promise((r) => setTimeout(r, 20));
  }
  await q.stop();
  return { puts: rec.puts, events, stats: q.stats() };
}

test("游客经在线上传队列传 3 个视频（6 个文件）全收；第 4 个视频小档进去、原尺寸被拒、不出队", async () => {
  const projectId = "p-queue";
  const items = [videoItem("one"), videoItem("two"), videoItem("three"), videoItem("four")];
  const { puts, events, stats } = await runQueue(items, { base, ticket: projectId, accountProject: true });
  const store = factory.project(projectId).stores.media;
  const stored = new Map((await store.inventory()).stored.map((e) => [e.hash, e.tier]));
  for (const it of items.slice(0, 3)) for (const t of it.tiers) assert.equal(stored.get(t.hash), t.tier, `${it.name} ${t.tier} 入库且档位对`);
  const [small4, original4] = items[3].tiers;
  assert.equal(stored.get(small4.hash), "small", "第 4 个视频的小档照收");
  assert.equal(stored.has(original4.hash), false, "第 4 个视频的原尺寸被拒");
  assert.equal(stats.done, 3, "前 3 项出队");
  assert.deepEqual(stats.items, ["v-four"], "第 4 项留在队里等退避");
  const failed = events.find((e) => e.event === "upload.tier-failed" || e.event === "upload.item-failed" || e.event === "upload.retry") ?? null;
  assert.ok(stats.failures >= 1, `第 4 项失败过：${JSON.stringify(failed)}`);
  // 每一片都带了档位头，和这一档对得上
  const tierByHash = new Map(items.flatMap((it) => it.tiers.map((t) => [t.hash, t.tier])));
  assert.ok(puts.length >= 8);
  for (const p of puts) assert.equal(p.tier, tierByHash.get(p.hash), `PUT ${p.hash.slice(0, 8)} 的 X-Media-Tier`);
});

test("不是云端账号项目的目标（本地项目、经托管中继）：PUT 不带 X-Media-Tier", async () => {
  const { puts, stats } = await runQueue([videoItem("local")], { base, ticket: "p-local", accountProject: false });
  assert.equal(stats.done, 1);
  assert.equal(puts.length, 2);
  for (const p of puts) assert.equal(p.tier, undefined);
});
