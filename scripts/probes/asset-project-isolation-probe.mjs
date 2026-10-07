import '../lib/no-user-dirs.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { startAssetProjectFixture } from '../../server/test/fixtures/asset-project-service.mjs';

// 实际 asset/media/shots 模块与回环 HTTP；principal/provider 是可注入夹具，非生产 account/中央挂载。
const args = process.argv.slice(2), port = Number(args.includes('--port') ? args[args.indexOf('--port') + 1] : 5780);
if (!Number.isInteger(port) || port < 5780 || port > 5789) throw new Error('asset isolation owned port required');
const out = args.includes('--out') ? path.resolve(args[args.indexOf('--out') + 1]) : await fs.mkdtemp(path.join(os.tmpdir(), 'pc-asset-project-probe-'));
if (!out.startsWith(path.resolve(os.tmpdir()) + path.sep)) throw new Error('probe output must stay in TMP');
await fs.mkdir(out, { recursive: true });
const fixture = await startAssetProjectFixture({ port, out: path.join(out, 'service') });
const bytes = Buffer.from('public generated asset project boundary fixture'), hash = crypto.createHash('sha256').update(bytes).digest('hex'), checks = [];
const req = (project, url, options = {}) => fetch(`${fixture.base}${url}`, { ...options, headers: { Authorization: `Bearer ${project}-rw`, ...options.headers } });
const check = (name, passed, detail = null) => { checks.push({ name, passed: !!passed, detail }); };
async function put(project, ns) {
  const chunk = await req(project, `/api/asset/${ns}/${hash}/0`, { method: 'PUT', body: bytes, headers: { 'X-Media-Size': String(bytes.length), 'X-Media-Ext': 'wav' } }); await chunk.arrayBuffer();
  const complete = await req(project, `/api/asset/${ns}/${hash}/complete`, { method: 'POST' }); await complete.arrayBuffer();
  check(`${ns}:${project}独立上传与完整收尾`, chunk.status === 200 && complete.status === 200, [chunk.status, complete.status]);
}
try {
  const unauth = await fetch(`${fixture.base}/api/asset/media/${hash}`); await unauth.arrayBuffer(); check('回环无凭证拒绝', unauth.status === 401, unauth.status);
  for (const ns of ['media', 'snap', 'px']) {
    await put('A', ns);
    for (const [name, options] of [['GET', {}], ['HEAD', { method: 'HEAD' }], ['Range', { headers: { Range: 'bytes=1-3' } }]]) { const r = await req('B', `/api/asset/${ns}/${hash}`, options); await r.arrayBuffer(); check(`${ns}:旧hosted residual 已知hash跨项目${name}拒绝`, r.status === 404, r.status); }
    const chunks = await (await req('B', `/api/asset/${ns}/${hash}/chunks`)).json(); check(`${ns}:B不暴露A分片`, chunks.size === null && chunks.received.length === 0);
    await put('B', ns); const b = await req('B', `/api/asset/${ns}/${hash}`); check(`${ns}:B独立同hash可读`, b.status === 200 && Buffer.from(await b.arrayBuffer()).equals(bytes));
  }
  await fixture.factory.removeProject('A');
  for (const ns of ['media', 'snap', 'px']) { const b = await req('B', `/api/asset/${ns}/${hash}`); check(`${ns}:删除A不影响B`, b.status === 200 && Buffer.from(await b.arrayBuffer()).equals(bytes)); }
  await fixture.revoke('B'); const revoked = await req('B', `/api/asset/media/${hash}`, { headers: { Range: 'bytes=0-1' } }); await revoked.arrayBuffer(); check('旧授权撤销后Range拒', revoked.status === 403, revoked.status);
} catch (error) { check('probe exception', false, { message: error.message, stack: error.stack }); }
finally { await fixture.close(); }
const result = { v: 1, scope: 'isolated-real-asset-service-injected-authority', productionMounted: false, hash, passed: checks.filter(c => c.passed).length, failed: checks.filter(c => !c.passed).length, checks };
await fs.writeFile(path.join(out, 'result.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify({ out, passed: result.passed, failed: result.failed })); if (result.failed) process.exitCode = 1;
