/**
 * 带共享项目的文档服务组装（M6a，契约 `docs/plan/auth-contract.md`）。独立模式的 `main.mjs` 与挂载模式的
 * `vite-plugin-docservice.ts` 都经这里组装，行为只按 `mode` 区分：
 *
 * | | `hosted`（独立模式，托管端） | `lan`（挂载模式，局域网主机） |
 * |---|---|---|
 * | 共享端点 | `/shared/…`，挂在自建的 http 服务器上 | `<path>/shared/…`，由宿主调 `handleHttp` |
 * | 谁能建项目 | 任何来源，按来源与总数限 | 只有本机回环 |
 * | 集群令牌 | 认，得到管理身份 | 一律不认 |
 *
 * 挂的模块：
 * - 渲染任务队列、项目、内容库、工具调用事件、成本记录（`modules/costs.mjs`）：**按空间各起一份**（`spaces.mjs`）。事件模块借同一空间的项目模块
 *   广播（项目频道）、借内容模块写 `event-detail`，所以这三个按空间配成一组（`bundleForSpace`）；`local` 空间的存储沿用 `dataDir` 本身
 *   （本地文档服务是 `<root>/out/docservice`，独立模式是数据目录），共享项目的空间在 `<dataDir>/tenants/<projectId>/`；
 * - 服务地址登记（`endpoints`）：全服务一份，管理接口；
 * - 共享项目（`shared`）：成员列表、创建者操作、票据。
 *
 * 托管方服务身份（`docs/plan/hosted-render-contract.md`）：`hosted` 模式下给了 `serviceRegistry`（服务登记表）时，握手认服务项与
 * 带 `sv` 的票据、答 `shared/service-challenge`、挂目录模块 `hosted`；带 `service` 字段的连接逐条消息按白名单放行
 * （`service-gate.mjs`），并重新核对登记表与项目的开关（接续前也核对）。`lan` 模式一律不认。
 *
 * 凭证存储在 `<dataDir>/auth/`（`../auth/store.mjs`），由调用方打开后传进来；传 null 表示没加载：
 * 共享端点回 503，凭证握手一律 401，回环本机身份照常。
 *
 * 本机信任（`trustLoopback`，环境变量 `PROMPTCUT_TRUST_LOOPBACK`，`docs/plan/http-transport-contract.md` 第 10 节）：
 * 缺省把回环来源当本机。部署在反向代理之后时，代理转进来的请求在这里看也是回环（语义：「本机」按真正的发起方判断，
 * `docs/semantics/mechanism/asset-service.md`），所以托管端传 false：这里的三处——文档服务握手（回环不带凭证 401、
 * 本机声明不认）、共享 HTTP 端点（按非回环来源限速）、创建者操作的限速——都不再认回环。素材服务与管理接口在托管组合里
 * （`server/hosted/combo.mjs`）按同一个开关办。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createDocService } from './service.mjs';
import { spacedModule, LOCAL_SPACE } from './spaces.mjs';
import { endpointsModule } from './modules/endpoints.mjs';
import { projectModule } from './modules/project.mjs';
import { contentModule } from './modules/content.mjs';
import { costsModule } from './modules/costs.mjs';
import { presenceModule } from './modules/presence.mjs';
import { eventsModule } from './modules/events.mjs';
import { sharedModule } from './modules/shared.mjs';
import { createFileStore, createMemoryStore } from './store/index.mjs';
import { createRenderQueue } from '../render-queue/index.mjs';
import { createHandshakeAuth } from '../auth/handshake.mjs';
import { isLocalOrigin, remoteTagOf } from '../auth/origin.mjs';
import { createSharedHttp } from '../auth/http.mjs';
import { createChallenges } from '../auth/challenges.mjs';
import { createRateLimiter } from '../auth/rate-limit.mjs';
import { isProjectId } from '../auth/protocol.mjs';
import { roomUnavailableReason } from '../recovery/relocation.mjs';
import { hostedModule } from './modules/hosted.mjs';
import { serviceGate } from './service-gate.mjs';
import { serviceAdmission } from '../auth/service-identity.mjs';

/**
 * @param {object} options
 * @param {'hosted' | 'lan'} options.mode
 * @param {string | null} [options.dataDir] `local` 空间的存储目录；null 时全部空间用内存存储（测试用）
 * @param {object | null} options.store 已打开的凭证存储（`openCredentialStore` / `credentialStoreFor`），null 表示没加载
 * @param {import('node:http').Server} [options.server] 挂载模式的宿主服务器
 * @param {string} [options.path] 挂载模式的 WebSocket 路径（共享端点在它下面），缺省 `/docservice`
 * @param {string} [options.clusterToken] 集群令牌（只在 `hosted` 认）
 * @param {(req) => boolean} [options.isLoopback] 请求是不是本机回环来的；缺省按 socket 对端地址
 * @param {boolean} [options.trustLoopback] 缺省 true；false 时回环来源不算本机（上面三处一律按远端对待），`isLoopback` 不再调
 * @param {(req) => string | null} [options.remoteOf] 来源地址；缺省 socket 对端地址
 * @param {{ deviceId: string, deviceName: string }} [options.localDevice] 本机声明用的本机设备
 * @param {() => number} [options.now] 注入时钟：挑战过期、限速、票据有效期都按它
 * @param {(event: string, fields: object) => void} [options.log]
 * @param {object} [options.limits] `{ createPerHour, maxProjects, challengeTtlMs, rateWindowMs, maxFailures, cooldownMs }`
 * @param {object} [options.service] 透传给 `createDocService` 的其余选项（`autoTick`、`heartbeatMs`、`sweepMs`……）
 * @param {(projectId: string) => void} [options.onCreate] 共享项目建成之后调（局域网主机据此开始广播，SP 契约第 4 节）
 * @param {(projectId: string) => void} [options.onDelete] 共享项目删掉之后调（局域网主机据此停止通告这个项目）
 * @param {object | null} [options.serviceRegistry] 托管方服务的登记表（`auth/service-identity.mjs` 的 `createServiceRegistry`）；
 *   只在 `hosted` 模式用，不给就没有服务身份
 * @param {(req) => boolean} [options.isDirectLocal] 服务握手用的「真正从本机发起」判据，缺省 `isLocalOrigin`（不看本机信任开关）
 * @param {number} [options.hostedLingerMs] 目录里 `active` 的保持时长（测试用）
 */
export function createSharedDocService({
  mode,
  dataDir = null,
  store = null,
  server,
  path: wsPath = '/docservice',
  clusterToken,
  // 「本机」按真正的发起方判断：对端回环且转发头里每一跳都是回环（`auth/origin.mjs`，契约第 10 节）
  isLoopback: isLoopbackOption = (req) => isLocalOrigin(req),
  trustLoopback = true,
  // 经反向代理转来的回环记成 `proxied:<对端>`：只凭来源地址判本机的地方（创建者操作的限速豁免）不再把它当本机
  remoteOf = (req) => remoteTagOf(req),
  localDevice,
  now = Date.now,
  log,
  limits = {},
  service: serviceOptions = {},
  onCreate,
  onDelete,
  // C10a 第 5 节：邀请链接用的公网源（取 `--doc-public-url` / `PROMPTCUT_DOCSERVICE_PUBLIC_URL` 的源，托管组合传进来）；
  // `invite-create` 的回包带上它。没有就是 null，界面按自己连的地址拼
  linkOrigin = null,
  serviceRegistry = null,
  isDirectLocal = (req) => isLocalOrigin(req),
  hostedLingerMs,
} = {}) {
  if (mode !== 'hosted' && mode !== 'lan') throw new TypeError("createSharedDocService: mode 只能是 'hosted' 或 'lan'");
  const say = typeof log === 'function' ? log : undefined;
  // 本机信任关掉时，回环来源与别的来源一样对待（第 10 节）
  const isLoopback = trustLoopback === false ? () => false : isLoopbackOption;
  const joinChallenges = createChallenges({ now, ttlMs: limits.challengeTtlMs });
  const adminChallenges = createChallenges({ now, ttlMs: limits.challengeTtlMs });
  const limiter = createRateLimiter({ now, windowMs: limits.rateWindowMs, maxFailures: limits.maxFailures, cooldownMs: limits.cooldownMs });
  const storeOf = () => store;
  const registry = mode === 'hosted' ? serviceRegistry ?? null : null;
  const registryOf = () => registry;
  /** 服务身份此刻还能不能用（逐消息与接续前都问）：控制连接看登记表，数据连接另看项目与开关 */
  function serviceRefusal(principal) {
    if (typeof principal?.service !== 'string' && principal?.scope !== 'service') return null;
    if (!registry) return 'forbidden';
    if (!isProjectId(principal.tenantId)) return registry.has(principal.service, principal.serviceKid) ? null : 'service-revoked';
    return serviceAdmission({
      registry, record: storeOf()?.peek(principal.tenantId) ?? null, service: principal.service, kid: principal.serviceKid, role: principal.role,
    });
  }

  const auth = createHandshakeAuth({
    store: storeOf,
    challenges: joinChallenges,
    limiter,
    clusterToken: mode === 'hosted' ? clusterToken : undefined,
    acceptToken: mode === 'hosted',
    isLoopback,
    remoteOf,
    localDevice,
    services: registryOf,
    isDirectLocal,
    now,
    log: say,
  });

  const sharedHttp = createSharedHttp({
    store: storeOf,
    challenges: joinChallenges,
    limiter,
    mode,
    isLoopback,
    remoteOf,
    now,
    log: say,
    createPerHour: limits.createPerHour,
    maxProjects: limits.maxProjects,
    ...(typeof onCreate === 'function' ? { onCreate } : {}),
    authenticate: auth.authenticate,
    services: registryOf,
  });
  const prefix = mode === 'hosted' ? '' : wsPath.replace(/\/+$/, '');

  const service = createDocService({
    ...serviceOptions,
    gate(principal, type, msg) {
      const reason = isProjectId(principal?.tenantId) ? roomUnavailableReason(storeOf()?.peek(principal.tenantId)) : null;
      // 托管方服务身份：白名单（缺省拒绝），再核对登记表与项目的开关
      return reason ?? serviceGate(principal, type, msg) ?? serviceRefusal(principal) ?? serviceOptions.gate?.(principal, type, msg) ?? null;
    },
    resumeGate(principal) {
      const reason = isProjectId(principal?.tenantId) ? roomUnavailableReason(storeOf()?.peek(principal.tenantId)) : null;
      return reason ?? serviceRefusal(principal) ?? serviceOptions.resumeGate?.(principal) ?? null;
    },
    ...(mode === 'lan' ? { server, path: wsPath } : { http: (req, res) => sharedHttp.handle(req, res, '') || serviceOptions?.http?.(req, res) === true }),
    authenticate: auth.authenticate,
    remoteOf,
    now,
    ...(say ? { log: say } : {}),
  });

  const localStore = dataDir ? createFileStore({ dir: dataDir, ...(say ? { log: say } : {}) }) : createMemoryStore();
  const tenantDir = (space) => (dataDir && isProjectId(space) ? path.join(dataDir, 'tenants', space) : null);
  /** 空间 → 日志存储；项目版本与内容库共用一份 */
  const spaceStores = new Map([[LOCAL_SPACE, localStore]]);
  function storeForSpace(space) {
    let st = spaceStores.get(space);
    if (!st) {
      const dir = tenantDir(space);
      st = dir ? createFileStore({ dir, ...(say ? { log: say } : {}) }) : createMemoryStore();
      spaceStores.set(space, st);
    }
    return st;
  }

  service.mountRenderQueue((space) => createRenderQueue({ now, send: service.send }));
  service.mount(endpointsModule());
  if (registry) service.mount(hostedModule({ store: storeOf, registry: registryOf, now, ...(Number.isFinite(hostedLingerMs) ? { lingerMs: hostedLingerMs } : {}) }));
  /** 空间 → { project, content, events }：同一空间的三个实例配成一组，事件模块要借另外两个 */
  const bundles = new Map();
  function bundleForSpace(space) {
    let b = bundles.get(space);
    if (!b) {
      const project = projectModule({ store: storeForSpace(space) });
      const content = contentModule({ store: storeForSpace(space) });
      // 成本记录（C10 其余第 3 节）：和内容库共用这个空间的存储，按项目空间隔离
      b = {
        project, content, events: eventsModule({ project, content }), costs: costsModule({ space, store: storeForSpace(space) }),
        // 在场状态(A3 第二阶段):成员页面的「正在编辑」、Agent 的范围与消息,只在内存里转发,借项目频道广播
        presence: presenceModule({ project }),
      };
      bundles.set(space, b);
    }
    return b;
  }
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).project }));
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).content }));
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).events }));
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).costs }));
  service.mount(spacedModule({ create: (space) => bundleForSpace(space).presence }));
  service.mount(sharedModule({
    store: storeOf,
    challenges: adminChallenges,
    limiter,
    claimsOf: (connId) => service.claimsOf(connId),
    // 创建者操作的限速按连接的来源地址判回环，与握手用同一个判据（连接只记了地址，拼一个只有对端地址的请求）
    isLoopbackRemote: (remote) => {
      try {
        return !!isLoopback({ socket: { remoteAddress: remote }, headers: {} });
      } catch {
        return false;
      }
    },
    now,
    linkOrigin,
    hostedServices: registry ? { registry: registryOf, releaseClaims: (connId) => service.releaseClaims(connId, 'service-disabled') } : null,
    dropSpace(space) {
      // 先通知（记录已经删掉了）：清数据目录失败也不影响停止通告
      if (typeof onDelete === 'function') {
        try { onDelete(space); } catch (err) { say?.('module.error', { module: 'shared', hook: 'onDelete', message: String(err?.message ?? err) }); }
      }
      service.dropSpace(space);
      spaceStores.delete(space);
      bundles.delete(space);
      const dir = tenantDir(space);
      if (dir) fs.rmSync(dir, { recursive: true, force: true });
    },
  }));

  /** Import into an old, durably moved space must discard both sessions and replay caches. */
  service.reloadSpace = space => {
    if (!isProjectId(space) || !roomUnavailableReason(storeOf()?.peek(space))) throw new Error('Room must be fenced before reload');
    service.closeSpace(space); service.dropSpace(space); spaceStores.delete(space); bundles.delete(space);
  };
  return {
    service,
    /** 凭证存储（可能是 null） */
    get store() { return store; },
    /** 托管方服务的登记表（没有是 null） */
    get serviceRegistry() { return registry; },
    authenticate: auth.authenticate,
    /**
     * 挂载模式：宿主把 HTTP 请求交进来，是 `<path>/shared/…` 的就处理并回 true，别的回 false、什么都不动。
     * 独立模式的端点已经挂在自建服务器上，这个函数也能用（前缀是空串）。
     */
    handleHttp(req, res) {
      return sharedHttp.handle(req, res, prefix);
    },
    /** 共享端点的路径前缀（`/shared/` 前面的部分） */
    sharedPrefix: `${prefix}/shared/`,
  };
}
