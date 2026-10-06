/**
 * 托管方渲染服务管理进程的本机代理口与诊断口（契约 `docs/plan/hosted-render-contract.md` 第 7.1 节）。只绑回环。
 *
 * | 路径 | 谁用 | 内容 |
 * |---|---|---|
 * | `GET /status` | 人、探针、部署脚本 | 目录状态、选中的项目、工作进程、资源读数、背压、自检、代码版本；不含票据与密钥。不要口令 |
 * | `GET /projects` | 工作进程 | `{ ok, docUrl, paused, projects: [{ projectId, members, drain, nodeId }] }`：它现在该连哪些项目 |
 * | `POST /ticket { projectId }` | 工作进程 | `{ ok, ticket }`：一张连接票据（转给目录的 `hosted.ticket`）；只给清单里的项目 |
 * | `POST /report { pid, queue }` | 工作进程 | 把自己的诊断交过来（管理进程不反过来请求工作进程） |
 *
 * 后三条要 `Authorization: Bearer <这次启动随机生成的口令>`（经环境变量交给工作进程）。卡片代码跑在 Chrome 页面里，
 * 读不到工作进程的环境变量，所以即使它能请求这个端口也过不了这一关。
 *
 * `selectProjects` 是纯函数：从目录清单与工作进程此刻手里的认领，定出它该连的项目——
 * - 开关开着（`enabled`）且有活（`active`）的连；
 * - 开关开着、没活了、但手里还有认领的：标 `drain`（做完再断）；
 * - 开关关了或已不在目录里的：不列（工作进程让掉认领后断开）；
 * - 超过 `maxProjects` 时有成员在线的先连，其次按变成有活的先后；排不上的记在 `waiting` 里。
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';

/** 节点 id：`hosted-render:<instanceId 前 12 位>/<projectId 去掉 sp_ 的前 8 位>` */
export const nodeIdFor = (instanceId, projectId) => `hosted-render:${String(instanceId).slice(0, 12)}/${String(projectId).replace(/^sp_/, '').slice(0, 8)}`;

/**
 * @param {object} o
 * @param {{ projectId, enabled, active, members, since }[]} o.directory 目录清单
 * @param {Record<string, number>} [o.held] projectId → 工作进程此刻持有的认领数
 * @param {number} o.maxProjects
 * @param {string} o.instanceId
 * @returns {{ projects: { projectId, members, drain, nodeId }[], waiting: string[] }}
 */
export function selectProjects({ directory, held = {}, maxProjects, instanceId }) {
  const want = [];
  const draining = [];
  for (const p of directory) {
    if (!p.enabled) continue;
    if (p.active) want.push(p);
    else if ((held[p.projectId] ?? 0) > 0) draining.push(p);
  }
  want.sort((a, b) => (a.members === b.members ? (a.since ?? 0) - (b.since ?? 0) || (a.projectId < b.projectId ? -1 : 1) : a.members ? -1 : 1));
  const room = Math.max(0, maxProjects - draining.length);
  const picked = want.slice(0, room);
  return {
    projects: [
      ...picked.map((p) => ({ projectId: p.projectId, members: p.members === true, drain: false, nodeId: nodeIdFor(instanceId, p.projectId) })),
      ...draining.map((p) => ({ projectId: p.projectId, members: p.members === true, drain: true, nodeId: nodeIdFor(instanceId, p.projectId) })),
    ],
    waiting: want.slice(room).map((p) => p.projectId),
  };
}

const sha = (text) => createHash('sha256').update(String(text), 'utf8').digest();

function send(res, status, body) {
  if (res.headersSent) return;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

function readJson(req, max = 4 * 1024 * 1024) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => { size += c.length; if (size <= max) chunks.push(c); });
    req.on('end', () => {
      if (size > max) return resolve(null);
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { resolve(null); }
    });
    req.on('error', () => resolve(null));
  });
}

/**
 * @param {object} o
 * @param {string} o.key 这次启动的口令
 * @param {() => object} o.listing 回 `/projects` 的内容（不含 `ok`）
 * @param {(projectId: string) => Promise<{ ticket: string }>} o.ticket
 * @param {(body: object) => void} o.report
 * @param {() => object} o.status
 * @param {() => { name: string, key: string, listing: () => object, report: (body: object) => void }[]} [o.clients] 另外的工作进程（隔离工作进程）
 * @param {(event: string, fields?: object) => void} [o.log]
 */
export function createBroker({ key, listing, ticket, report, status, clients = null, log = () => {} }) {
  /*
   * 口令按工作进程分（契约第 7.5 节）：常驻工作进程一把（`key` / `listing` / `report`），隔离工作进程一把（`clients()` 每次请求现取——
   * 它的口令每一轮都换，没在跑时不在表里）。哪把口令进来就只看得到那个工作进程自己的清单、只要得到清单里那些项目的票据、
   * 交的诊断也只记在它名下：隔离工作进程即使整个被项目带来的代码拿下，凭它的口令也要不到别的项目的票据、看不到别的项目的 id。
   */
  const single = typeof key === 'string' && key ? { name: 'resident', key, listing, report } : null;
  /** 这条请求是哪个工作进程发的；口令对不上回 null。逐个比完（不提前返回） */
  const clientOf = (req) => {
    const m = /^Bearer[ \t]+(\S+)$/i.exec(String(req.headers.authorization ?? '').trim());
    if (!m) return null;
    const given = sha(m[1]);
    let hit = null;
    for (const c of [...(single ? [single] : []), ...((typeof clients === 'function' ? clients() : null) ?? [])]) {
      if (c && typeof c.key === 'string' && c.key && timingSafeEqual(given, sha(c.key)) && !hit) hit = c;
    }
    return hit;
  };
  /** 浏览器发来的请求（带 `Sec-Fetch-Site` 或 `Origin`，页面脚本去不掉）：这个口不是给页面用的，连 `/status` 也不答 */
  const fromBrowser = (req) => !!req.headers['sec-fetch-site'] || !!req.headers.origin;

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://broker.local');
      if (fromBrowser(req)) { req.resume(); log('broker.browser-refused', { path: url.pathname.slice(0, 80) }); return send(res, 403, { ok: false, error: 'forbidden' }); }
      if (req.method === 'GET' && url.pathname === '/status') return send(res, 200, { ok: true, ...status() });
      const client = clientOf(req);
      if (!client) { req.resume(); return send(res, 401, { ok: false, error: 'unauthorized' }); }
      if (req.method === 'GET' && url.pathname === '/projects') return send(res, 200, { ok: true, ...client.listing() });
      if (req.method === 'POST' && url.pathname === '/ticket') {
        const body = await readJson(req);
        const projectId = body?.projectId;
        if (typeof projectId !== 'string' || !client.listing().projects.some((p) => p.projectId === projectId)) {
          log('broker.ticket-not-listed', { client: client.name });
          return send(res, 403, { ok: false, error: 'not-listed' });
        }
        try {
          const out = await ticket(projectId, client.name);
          return send(res, 200, { ok: true, ticket: out.ticket });
        } catch (err) {
          log('broker.ticket-refused', { projectId, client: client.name, reason: String(err?.code ?? 'error') });
          return send(res, 503, { ok: false, error: String(err?.code ?? 'ticket-failed') });
        }
      }
      if (req.method === 'POST' && url.pathname === '/report') {
        const body = await readJson(req);
        if (body && typeof body === 'object') client.report(body);
        return send(res, 200, { ok: true });
      }
      req.resume();
      return send(res, 404, { ok: false, error: 'not-found' });
    } catch (err) {
      log('broker.error', { message: String(err?.message ?? err) });
      send(res, 500, { ok: false, error: 'internal' });
    }
  });

  return {
    server,
    listen(port, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => { server.off('error', reject); resolve(server.address()); });
      });
    },
    close() {
      return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections?.(); });
    },
  };
}
