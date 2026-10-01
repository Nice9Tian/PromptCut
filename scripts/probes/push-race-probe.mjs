/**
 * 尺子:两路同时推同一批内容时,素材服务 `complete` 会不会回 400 incomplete(claude/push-incomplete,
 * 报告 `docs/reports/AGENT-push-incomplete.md`)。
 *
 * 现场(M7 浏览器节点探针):节点渲完一段,队列节点的产物库(`artifact-transfer.mjs` 的 `createAssetSink().put`)
 * 与本机的无条件推送队列(`artifact-push.mjs`)几乎同时推同一段的 180 块,两边都是 `pushResult`(每路 4 并发)
 * → `client.put`(问 chunks → PUT 缺的片 → POST complete)。本探针在本进程里起一个真的素材服务
 * (`server/asset-service.ts` 的中间件 + `fs-store`),用两个真的客户端照这个形状推,数各类失败。
 *
 *   node scripts/probes/push-race-probe.mjs [--port 6440] [--rounds 20] [--blocks 180] [--size 20000]
 *        [--store flat|shard|memory] [--lanes 4] [--stagger-ms 0]
 *
 * 每轮新造 `blocks` 块随机内容(每块一片),两路各 `lanes` 并发、同一顺序推;第二路晚 `stagger-ms` 起步。
 * 输出一行 JSON:`{ rounds, pushes, failedPushes, errors: { "<status>:<error>": 次数 }, ... }`;
 * 有任何一次推送失败退出码 1,全过退出 0。
 */
import http from 'node:http';
import os from 'node:os';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { registerTsResolve } from '../../server/hosted/ts-resolve.mjs';
import { createFsStore, createMemoryStore, createAssetClient } from '../../server/asset-store/index.mjs';

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 && at + 1 < process.argv.length ? process.argv[at + 1] : fallback;
}
const port = Number(arg('port', 6440));
const rounds = Number(arg('rounds', 20));
const blocks = Number(arg('blocks', 180));
const size = Number(arg('size', 20000));
const storeKind = String(arg('store', 'flat'));
const lanes = Number(arg('lanes', 4));
const staggerMs = Number(arg('stagger-ms', 0));

registerTsResolve();
const assetService = await import('../../server/asset-service.ts');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-push-race-'));
const makeStore = (ns) => {
  if (storeKind === 'memory') return createMemoryStore({});
  return createFsStore({ dir: path.join(dir, ns), shard: storeKind === 'shard' });
};
const stores = { media: makeStore('media'), snap: makeStore('snap'), px: makeStore('px') };
const middleware = assetService.assetServiceMiddleware(dir, { stores, tickets: null, isTrusted: () => true, pxEvict: null, pullArtifact: null });
const server = http.createServer((req, res) => middleware(req, res, () => { res.statusCode = 404; res.end('{}'); }));
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
const base = `http://127.0.0.1:${port}/api/asset`;

const errors = {};
let pushes = 0;
let failedPushes = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 照 `pushResult` 的形状:`lanes` 路并发,逐块 `client.put` */
async function pushAll(client, items) {
  let next = 0;
  let failed = 0;
  const lane = async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      try {
        await client.put('px', items[i], { ext: 'webp' });
      } catch (err) {
        failed++;
        const key = `${err?.status ?? err?.code ?? 'error'}:${err?.body?.error ?? String(err?.message ?? err).slice(0, 60)}`;
        errors[key] = (errors[key] ?? 0) + 1;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(lanes, items.length) }, lane));
  pushes++;
  if (failed) failedPushes++;
  return failed;
}

const started = Date.now();
try {
  for (let r = 0; r < rounds; r++) {
    const items = Array.from({ length: blocks }, () => crypto.randomBytes(size));
    const a = createAssetClient({ base, retries: 3 });
    const b = createAssetClient({ base, retries: 3 });
    await Promise.all([pushAll(a, items), (async () => { if (staggerMs > 0) await sleep(staggerMs); return pushAll(b, items); })()]);
  }
} finally {
  await new Promise((resolve) => server.close(resolve));
  fs.rmSync(dir, { recursive: true, force: true });
}
const out = { rounds, blocks, size, store: storeKind, lanes, staggerMs, pushes, failedPushes, errors, ms: Date.now() - started };
console.log(JSON.stringify(out));
process.exit(failedPushes > 0 ? 1 : 0);
