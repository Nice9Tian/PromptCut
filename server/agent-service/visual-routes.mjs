/**
 * 云端 Agent 可视记录受权 HTTP 路由处理器（拆包表 V1 `server/agent-service/visual-routes.mjs`）。
 *
 * 供挂载到 Agent 服务：
 *   - `GET /agent/v1/conversations/:id/visuals/:vid`（含 `/v1/conversations/:id/visuals/:vid` 及可选 `.json` 后缀）
 *   - `GET /agent/v1/conversations/:id/visuals/:vid/files/:name`（含 `/v1/conversations/:id/files/:name`）
 *
 * 权限与缓存铁律：
 *   - 每次读取均经文档服务（`service.access` / `authorizeConversation`）核对当前请求者在 `projectId + conversationId` 下的对话读取权限：
 *     - `shared`：对当前有效项目成员开放；
 *     - `private`：仅对对话 owner 及项目创建者（只读例外 `creatorReadOnly`）开放，普通成员一律 403/404 拒绝；
 *     - 被踢、退出、跨项目、跨对话一律 401/403/404 拒绝；
 *   - 响应头与缓存键绑定当前 `aclRevision`（`Cache-Control: private, no-store`、`X-PC-ACL-Revision`）；
 *     若请求携带旧的 `?aclRevision=` 且与当前对话的 `aclRevision` 不一致（如共有转私有后持旧地址访问），立即拒绝；
 *   - 对外返回的记录剥离内部 `gifAssetRef`，所有动图/截图字节只经本受权对话端点下发，绝不允许凭已知 asset hash 绕过对话 ACL 直取。
 *
 * 纯 Node 模块，不引用 `src/`。
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { CONVERSATION_ID_RE } from '../agent/service/create-agent-service.mjs';
import {
  conversationVisualsDir,
  createVisualsStore,
  isVisualId,
  safeFileName,
  visualCacheKey,
  visualFileUrl,
} from '../agent/service/hosted-visuals.mjs';

const CORS = Object.freeze({
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-PC-ACL-Revision',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Max-Age': '600',
});

const RECORD_ROUTE_RE = /^(?:\/agent)?\/v1\/conversations\/([^/]+)\/visuals\/(v-[0-9a-z]{6,40})(?:\.json)?$/;
const FILE_WITH_VID_ROUTE_RE = /^(?:\/agent)?\/v1\/conversations\/([^/]+)\/visuals\/(v-[0-9a-z]{6,40})\/files\/([^/]+)$/;
const FILE_DIRECT_ROUTE_RE = /^(?:\/agent)?\/v1\/conversations\/([^/]+)\/files\/([^/]+)$/;

/**
 * 解析可视记录路由路径。不匹配返回 null。
 * @param {string} pathname
 */
export function matchVisualRoute(pathname) {
  let m = RECORD_ROUTE_RE.exec(pathname);
  if (m) {
    const conversationId = decodeURIComponent(m[1]);
    const visualId = m[2];
    if (!CONVERSATION_ID_RE.test(conversationId) || !isVisualId(visualId)) return null;
    return { kind: 'record', conversationId, visualId };
  }
  m = FILE_WITH_VID_ROUTE_RE.exec(pathname);
  if (m) {
    const conversationId = decodeURIComponent(m[1]);
    const visualId = m[2];
    const fileName = safeFileName(decodeURIComponent(m[3]));
    if (!CONVERSATION_ID_RE.test(conversationId) || !isVisualId(visualId) || !fileName) return null;
    return { kind: 'file', conversationId, visualId, fileName };
  }
  m = FILE_DIRECT_ROUTE_RE.exec(pathname);
  if (m) {
    const conversationId = decodeURIComponent(m[1]);
    const fileName = safeFileName(decodeURIComponent(m[2]));
    if (!CONVERSATION_ID_RE.test(conversationId) || !fileName) return null;
    return { kind: 'file', conversationId, visualId: null, fileName };
  }
  return null;
}

function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent || res.writableEnded) return;
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
    Vary: 'Authorization',
    ...CORS,
    ...extraHeaders,
  });
  res.end(JSON.stringify(body));
}

/**
 * 脱敏并重写记录内的文件地址，绑定当前 `aclRevision`，隐藏内部 `gifAssetRef`。
 */
export function sanitizePublicVisualRecord(record, aclRevision) {
  const { gifAssetRef: _hiddenRef, ...rest } = record;
  const cid = record.conversationId;
  const vid = record.visualId;
  const out = {
    ...rest,
    aclRevision,
    cacheKey: visualCacheKey({
      projectId: record.projectId,
      conversationId: cid,
      visualId: vid,
      aclRevision,
    }),
  };
  if (Array.isArray(record.images)) {
    out.images = record.images.map((im) => {
      const file = im?.file || (typeof im?.url === 'string' ? im.url.split('?')[0].split('/').pop() : null);
      return {
        ...(im?.label ? { label: im.label } : {}),
        url: file ? visualFileUrl(cid, vid, file, aclRevision) : im.url,
      };
    });
  }
  if (record.before) {
    const file = record.before.file || (typeof record.before.gif === 'string' ? record.before.gif.split('?')[0].split('/').pop() : null);
    out.before = {
      ...(record.before.spec ? { spec: record.before.spec } : {}),
      gif: file ? visualFileUrl(cid, vid, file, aclRevision) : record.before.gif,
    };
  }
  if (record.after) {
    const file = record.after.file || (typeof record.after.gif === 'string' ? record.after.gif.split('?')[0].split('/').pop() : null);
    out.after = {
      ...(record.after.spec ? { spec: record.after.spec } : {}),
      gif: file ? visualFileUrl(cid, vid, file, aclRevision) : record.after.gif,
    };
    out.gif = out.after.gif;
  }
  return out;
}

/**
 * @param {object} o
 * @param {string} [o.dataDir]
 * @param {object | Function} [o.workspace]
 * @param {ReturnType<typeof createVisualsStore>} [o.store]
 * @param {(req: import('node:http').IncomingMessage) => Promise<object | null> | object | null} [o.authenticate]
 * @param {(identity: object, conversationId: string, action: 'read') => Promise<object>} [o.authorizeConversation]
 * @param {object} [o.service] `createAccountConversationService` 或包含 `access(identity, conversationId, 'read')` 的服务实例
 * @param {Function} [o.renderOnDemand] 可选：首次访问未生成的文件时按 spec 惰性生成 `({ projectId, conversationId, visualId, record, fileName }) => Promise<Buffer | null>`
 */
export function createVisualRoutes({
  dataDir = null,
  workspace = null,
  store: injectedStore = null,
  authenticate = null,
  authorizeConversation = null,
  service = null,
  renderOnDemand = null,
  log = () => {},
} = {}) {
  const store = injectedStore ?? createVisualsStore({ dataDir, workspace });
  const say = (event, fields = {}) => { try { log(event, fields); } catch {} };

  async function resolveIdentity(req, preAuthenticated = null) {
    if (preAuthenticated && typeof preAuthenticated.projectId === 'string') return preAuthenticated;
    if (typeof authenticate !== 'function') return null;
    try {
      const id = await authenticate(req);
      if (!id || typeof id.projectId !== 'string') return null;
      const accountId = id.accountId ?? id.userId ?? null;
      if (typeof accountId !== 'string' || !accountId) return null;
      return { ...id, accountId, userId: id.userId ?? accountId };
    } catch (error) {
      if (error?.status) throw error;
      return null;
    }
  }

  /**
   * 每次读取都向文档服务（或注入的对话权威）核实 `projectId + conversationId` 的当前读取权限与 `aclRevision`。
   */
  async function checkConversationRead(identity, conversationId) {
    if (identity.revoked === true || identity.banned === true || identity.kicked === true) {
      throw Object.assign(new Error('forbidden'), { status: 403, code: 'forbidden' });
    }
    const checkFn = typeof authorizeConversation === 'function'
      ? (id, cid) => authorizeConversation(id, cid, 'read')
      : (typeof service?.access === 'function' ? (id, cid) => service.access(id, cid, 'read') : null);
    if (!checkFn) {
      throw Object.assign(new Error('visual-authority-unavailable'), { status: 503, code: 'unavailable' });
    }
    const access = await checkFn(identity, conversationId);
    if (!access || access.allowed !== true) {
      throw Object.assign(new Error(access?.code ?? 'forbidden'), {
        status: access?.status ?? 403,
        code: access?.code ?? 'forbidden',
      });
    }
    if (access.projectId && access.projectId !== identity.projectId) {
      throw Object.assign(new Error('project-mismatch'), { status: 403, code: 'forbidden' });
    }
    // 纵深防御：若返回了 visibility === 'private'，再次核对必须是 owner 或项目创建者（只读例外）
    const visibility = access.visibility ?? 'shared';
    if (visibility === 'private') {
      const accountId = identity.accountId ?? identity.userId;
      const isOwner = typeof access.ownerAccountId === 'string' && access.ownerAccountId === accountId;
      const isCreator = identity.creator === true || access.creatorReadOnly === true || (typeof access.creatorAccountId === 'string' && access.creatorAccountId === accountId);
      if (!isOwner && !isCreator) {
        throw Object.assign(new Error('private-conversation-forbidden'), { status: 403, code: 'forbidden' });
      }
    }
    const aclRevision = Number.isInteger(access.aclRevision) ? access.aclRevision : 1;
    return {
      allowed: true,
      visibility,
      aclRevision,
      ownerAccountId: access.ownerAccountId ?? null,
      creatorReadOnly: Boolean(access.creatorReadOnly || (visibility === 'private' && identity.creator === true && access.ownerAccountId !== (identity.accountId ?? identity.userId))),
    };
  }

  /** 当路由是 `/v1/conversations/:id/files/:name`（未在路径带 `:vid`）时，在该对话的 visuals 目录下定位所属的 visualId */
  async function findVisualIdForFile(scope, fileName) {
    if (!dataDir) return null;
    const dir = conversationVisualsDir(dataDir, scope.projectId, scope.conversationId);
    let entries = [];
    try {
      entries = await fs.readdir(dir);
    } catch {
      return null;
    }
    for (const entry of entries) {
      if (!entry.endsWith('.json')) continue;
      const vid = entry.slice(0, -5);
      if (!isVisualId(vid)) continue;
      const found = await store.readFile(scope, vid, fileName);
      if (found) return vid;
    }
    return null;
  }

  /**
   * 处理一条 HTTP 请求。若路径不屬於可视记录路由返回 `false`；已处理返回 `true`。
   */
  async function handle(req, res, preIdentity = null) {
    const rawUrl = new URL(req.url ?? '/', 'http://localhost');
    const matched = matchVisualRoute(rawUrl.pathname);
    if (!matched) return false;

    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      res.end();
      return true;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      sendJson(res, 405, { ok: false, code: 'method-not-allowed', message: 'GET only' });
      return true;
    }

    let identity;
    try {
      identity = await resolveIdentity(req, preIdentity);
    } catch (error) {
      sendJson(res, error?.status ?? 401, { ok: false, code: error?.code ?? 'unauthorized', message: error?.message ?? 'unauthorized' });
      return true;
    }
    if (!identity) {
      sendJson(res, 401, { ok: false, code: 'unauthorized', message: 'unauthorized' });
      return true;
    }

    const { conversationId } = matched;
    let acl;
    try {
      acl = await checkConversationRead(identity, conversationId);
    } catch (error) {
      const status = Number.isInteger(error?.status) ? error.status : 403;
      sendJson(res, status, { ok: false, code: error?.code ?? 'forbidden', message: error?.message ?? 'forbidden' });
      return true;
    }

    // 检查请求是否绑定了过期的 aclRevision（例如共有切私有或权限变更前的旧缓存键/URL）
    const reqAclRevRaw = rawUrl.searchParams.get('aclRevision') ?? req.headers?.['x-pc-acl-revision'] ?? null;
    if (reqAclRevRaw !== null && reqAclRevRaw !== '') {
      const reqAclRev = Number(reqAclRevRaw);
      if (!Number.isInteger(reqAclRev) || reqAclRev !== acl.aclRevision) {
        sendJson(res, 409, {
          ok: false,
          code: 'acl-revision-mismatch',
          aclRevision: acl.aclRevision,
          message: '对话可见性或权限版本已变更，请重新加载当前对话记录。',
        }, { 'X-PC-ACL-Revision': String(acl.aclRevision) });
        return true;
      }
    }

    const scope = { projectId: identity.projectId, conversationId };
    const headers = {
      'X-PC-ACL-Revision': String(acl.aclRevision),
      'X-PC-Visibility': acl.visibility,
    };

    if (matched.kind === 'record') {
      const rec = await store.readRecord(scope, matched.visualId);
      if (!rec || rec.projectId !== identity.projectId || rec.conversationId !== conversationId) {
        sendJson(res, 404, { ok: false, code: 'not-found', message: '找不到这条可视化记录' }, headers);
        return true;
      }
      const publicRec = sanitizePublicVisualRecord(rec, acl.aclRevision);
      sendJson(res, 200, {
        ok: true,
        aclRevision: acl.aclRevision,
        visibility: acl.visibility,
        creatorReadOnly: acl.creatorReadOnly,
        cacheKey: publicRec.cacheKey,
        record: publicRec,
      }, {
        ...headers,
        ETag: `W/"${rec.visualId}-acl-${acl.aclRevision}"`,
      });
      return true;
    }

    // matched.kind === 'file'
    const visualId = matched.visualId
      || rawUrl.searchParams.get('visualId')
      || req.headers?.['x-pc-visual-id']
      || await findVisualIdForFile(scope, matched.fileName);
    if (!visualId || !isVisualId(visualId)) {
      sendJson(res, 404, { ok: false, code: 'not-found', message: '找不到这个可视化文件' }, headers);
      return true;
    }

    let fileData = await store.readFile(scope, visualId, matched.fileName);
    if (!fileData && typeof renderOnDemand === 'function') {
      const rec = await store.readRecord(scope, visualId);
      if (rec && rec.projectId === identity.projectId && rec.conversationId === conversationId) {
        try {
          const generated = await renderOnDemand({
            projectId: identity.projectId,
            conversationId,
            visualId,
            record: rec,
            fileName: matched.fileName,
          });
          if (generated) {
            const ext = path.extname(matched.fileName).slice(1).toLowerCase() || 'gif';
            await store.saveFile(scope, generated, ext);
            fileData = await store.readFile(scope, visualId, matched.fileName);
          }
        } catch (err) {
          say('visual-routes.render-failed', { visualId, message: String(err?.message ?? err).slice(0, 120) });
        }
      }
    }

    if (!fileData) {
      sendJson(res, 404, { ok: false, code: 'not-found', message: '找不到这个可视化文件' }, headers);
      return true;
    }

    // 下发字节前再次核对对话读取权限与 aclRevision（防止长耗时按需渲染期间对话切私有或成员被踢）
    const aclAfter = await checkConversationRead(identity, conversationId).catch(() => null);
    if (!aclAfter || aclAfter.aclRevision !== acl.aclRevision) {
      sendJson(res, 403, { ok: false, code: 'forbidden', message: '读取权限已变更' });
      return true;
    }

    res.writeHead(200, {
      'Content-Type': fileData.contentType,
      'Content-Length': String(fileData.bytes.length),
      'Cache-Control': 'private, no-store',
      Vary: 'Authorization',
      'X-PC-ACL-Revision': String(acl.aclRevision),
      'X-PC-Visibility': acl.visibility,
      ETag: `W/"${visualId}-${matched.fileName}-acl-${acl.aclRevision}"`,
      ...CORS,
    });
    res.end(req.method === 'HEAD' ? undefined : fileData.bytes);
    return true;
  }

  return Object.assign(handle, {
    handle,
    store,
    matchVisualRoute,
  });
}
