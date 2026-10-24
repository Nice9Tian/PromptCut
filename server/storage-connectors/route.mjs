/**
 * 网盘连接器的 HTTP 层:给页面用的几个口,接在编辑器进程的素材路由上
 * (`../vite-plugin-media.ts`,任务书 `docs/plan/drive-connector-task.md` 第 5 节)。
 *
 * | 口 | 做什么 |
 * |---|---|
 * | `GET  /api/media/storage/config` | 页面要的公开参数(客户端 ID、API 密钥、项目编号),外加这台机器能不能用 A2 |
 * | `POST /api/media/storage/import` | 拉一份文件进素材库 |
 * | `POST /api/media/storage/connect` | A2:页面交来授权码,这里换出 refresh token 存起来 |
 * | `GET  /api/media/storage/connections` | A2:列出已连接的网盘(只回元信息) |
 * | `POST /api/media/storage/disconnect` | A2:向网盘撤销并删掉存着的那份 |
 * | `GET  /oauth2callback` | A2:授权弹窗落到这里,把授权码 postMessage 回开它的页面 |
 *
 * # 两条凭据路在这里怎么分叉
 *
 * - **A3 短命票**:页面自己拿一张一小时的 access token,随 `import` 请求递进来,用完即弃。
 * - **A2 凭据托管**:页面先走一次授权码流程(`connect`),之后 `import` 就**不用带令牌**了 ——
 *   这一侧自己拿 refresh token 换票。用户关掉页面也不影响。
 *
 * `import` 收到令牌就走 A3,没收到就找托管的凭据走 A2;两条都没有才报错。
 *
 * # 客户端密钥
 *
 * 只有 A2 用得上,从环境变量 `PROMPTCUT_GOOGLE_CLIENT_SECRET` 来(部署配置,不进代码库;
 * 本机那份的位置记在 `docs/local.md`)。没配就只有 A3 能用,`config` 里如实说。
 *
 * 只用 Node 内置模块。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStorageProvider, SUPPORTED_KINDS, StorageConnectorError } from './index.mjs';
import { importFromStorage } from './import.mjs';
import { createCredentialStore } from './credentials.mjs';
import { connectWithCode, createManagedToken, disconnect } from './managed-token.mjs';

/** 断点续传要的固定临时目录 */
export function pullTmpDir(env = process.env) {
  return env.PROMPTCUT_STORAGE_PULL_DIR || path.join(os.tmpdir(), 'promptcut-storage-pull');
}

/** 托管凭据放哪。口径和 `../costs-store.mjs`、`../frame-library-storage.mjs` 一致 */
export function credentialDir(root, env = process.env) {
  return path.join(env.PROMPTCUT_DATA_DIR || path.join(root, 'out'), 'storage-credentials');
}

/**
 * 一份托管凭据归谁。
 *
 * 共享项目按「项目 × 成员」分格(语义:别的成员读不到,别的项目用不了);本机项目没有账号体系,
 * 归到固定的一格。共享项目的导入本身还没接通(任务书第 9.1 节的待办),所以现在走到的都是本机那一格。
 */
export function connectionScope(provider, ownership = null) {
  return ownership
    ? { projectId: String(ownership.projectId), userId: String(ownership.authorizationId || 'member'), provider }
    : { projectId: 'local', userId: 'local', provider };
}

/** 每家网盘在界面上怎么显示。Dropbox 本轮只占位,见任务书第 2 节 */
const CATALOG = [
  { kind: 'google-drive', label: 'Google Drive', scope: 'https://www.googleapis.com/auth/drive.file' },
  { kind: 'dropbox', label: 'Dropbox', scope: null },
];

/** 「开发期写法」那句提示只打一次,别每个请求刷一行 */
let warnedInlineSecret = false;

/**
 * 客户端密钥从哪来。
 *
 * **优先读文件**(`PROMPTCUT_GOOGLE_CLIENT_SECRET_FILE` 给路径),这是部署时该走的那条路 ——
 * `../hosted/deploy/agent-account.env.example` 的文件头写明「里面没有任何秘密(私钥只写路径)」,
 * 密钥文件和 `PROMPTCUT_AGENT_CLIENT_KEY_FILE` 一个待遇:0600、属主是服务用户。
 *
 * 直接给值的 `PROMPTCUT_GOOGLE_CLIENT_SECRET` 留着,只为开发期方便(本机起开发服务器时从文件里
 * 读出来喂进环境变量比较顺手),用到它会在日志里说一句。两个都配时**文件优先**。
 *
 * 读不到文件不抛:回空串,等于「这台机器没配好 A2」,界面上「连接」按钮灰着并说明原因,A3 照常可用。
 */
function readClientSecret(env, log) {
  const file = String(env.PROMPTCUT_GOOGLE_CLIENT_SECRET_FILE || '');
  if (file) {
    try {
      const got = fs.readFileSync(file, 'utf8').trim();
      if (got) return got;
      log?.('storage.secret-file-empty', { file });
    } catch (e) {
      // 路径不对、权限不够、文件不在 —— 都只记一行,不带文件内容
      log?.('storage.secret-file-unreadable', { file, code: e?.code || String(e?.message || e) });
    }
    return '';
  }
  const inline = String(env.PROMPTCUT_GOOGLE_CLIENT_SECRET || '');
  if (inline && !warnedInlineSecret) {
    warnedInlineSecret = true;
    log?.('storage.secret-inline', { hint: '开发期写法;生产请改用 PROMPTCUT_GOOGLE_CLIENT_SECRET_FILE 只写路径' });
  }
  return inline;
}

/**
 * A2 要的三样:客户端 ID、客户端密钥、重定向地址。
 *
 * 只有客户端密钥是秘密,另外两样本来就出现在页面里。**这个函数的返回值不要整个往回包里塞**
 * (`storageConfig` 只取 `redirectUri`)。
 */
export function oauthConfig(env = process.env, log = defaultLog) {
  return {
    clientId: String(env.PROMPTCUT_GOOGLE_CLIENT_ID || ''),
    clientSecret: readClientSecret(env, log),
    redirectUri: String(env.PROMPTCUT_GOOGLE_REDIRECT_URI || ''),
  };
}

/** 默认的一行日志。密钥本身永远不进日志,只记「从哪读的、为什么没读到」 */
function defaultLog(event, fields) {
  console.log(`[storage] ${event}`, JSON.stringify(fields ?? {}));
}

/**
 * 页面要的配置。没配环境变量就 `configured: false`,界面把按钮置灰并说明原因,不报错。
 *
 * 下发的三样都不是秘密(会出现在页面源码里),靠的是 Google 控制台那一侧的来源限制。
 * **客户端密钥永远不下发**,只回一个 `canManage` 说明这台机器支不支持 A2。
 */
export function storageConfig(env = process.env) {
  const clientId = String(env.PROMPTCUT_GOOGLE_CLIENT_ID || '');
  const apiKey = String(env.PROMPTCUT_GOOGLE_API_KEY || '');
  const appId = String(env.PROMPTCUT_GOOGLE_PROJECT_NUMBER || '');
  // 这里每次页面加载都会调,日志交给真正要用密钥的那两条路(connect / import)去打
  const { clientSecret, redirectUri } = oauthConfig(env, null);
  return {
    ok: true,
    providers: CATALOG.map((p) => {
      if (p.kind !== 'google-drive') {
        return { ...p, configured: false, canManage: false, reason: '还没做,见任务书第 2 节' };
      }
      const configured = !!(clientId && apiKey && appId);
      // A2 另外要客户端密钥与重定向地址;只配了前三样时仍可用 A3
      const canManage = configured && !!clientSecret && !!redirectUri;
      return {
        ...p,
        configured,
        canManage,
        ...(configured ? { clientId, apiKey, appId, redirectUri } : {}),
        ...(configured
          ? (canManage ? {} : { manageReason: '没配 PROMPTCUT_GOOGLE_CLIENT_SECRET / PROMPTCUT_GOOGLE_REDIRECT_URI,只能用一次性授权' })
          : { reason: '没配 PROMPTCUT_GOOGLE_CLIENT_ID / PROMPTCUT_GOOGLE_API_KEY / PROMPTCUT_GOOGLE_PROJECT_NUMBER' }),
      };
    }),
  };
}

function checkKind(kind) {
  if (!SUPPORTED_KINDS.includes(kind)) {
    throw new StorageConnectorError(`不认识的网盘:${kind || '(没给)'}`, 'bad-request');
  }
  return kind;
}

/**
 * 校验页面交来的导入请求。
 *
 * **令牌可以不给**:不给就走 A2(用这一侧托管的凭据换票)。给了就走 A3,只看形状不看内容。
 */
export function parseImportBody(body) {
  const kind = checkKind(String(body?.kind || ''));
  const token = body?.token;
  if (token !== undefined && token !== null && (typeof token !== 'string' || !token || token.length > 4096)) {
    throw new StorageConnectorError('请求里的访问令牌形状不对', 'bad-request');
  }
  const fileId = body?.fileId;
  if (typeof fileId !== 'string' || !fileId) {
    throw new StorageConnectorError('请求里没有文件 id', 'bad-request');
  }
  const name = typeof body?.name === 'string' && body.name ? body.name : null;
  return { kind, token: typeof token === 'string' ? token : null, fileId, name };
}

/** `code` 到 HTTP 状态码。页面据此决定是提示重试、重新授权,还是认错收场 */
export function statusForCode(code) {
  switch (code) {
    case 'bad-request': return 400;
    case 'no-credential': return 401;
    case 'token-expired': return 401;
    case 'token-revoked': return 401;
    case 'no-refresh-token': return 400;
    case 'bad-client': return 401;
    case 'bad-credential': return 409;
    case 'forbidden': return 403;
    case 'not-found': return 404;
    case 'not-downloadable': return 415;
    case 'quota': return 429;
    case 'not-implemented': return 501;
    case 'network': return 502;
    default: return 500;
  }
}

function storeFor(ctx) {
  return ctx?.store ?? createCredentialStore({ dir: credentialDir(ctx.root, ctx?.env ?? process.env) });
}

/**
 * 拉一份文件进素材库。有令牌走 A3,没令牌找托管凭据走 A2。
 */
export async function handleStorageImport(body, ctx) {
  const { kind, token, fileId, name } = parseImportBody(body);
  const env = ctx?.env ?? process.env;

  let tokenSource = token;
  if (!tokenSource) {
    const { clientId, clientSecret } = oauthConfig(env);
    if (!clientId || !clientSecret) {
      throw new StorageConnectorError('这次没带授权,而这台机器也没配好凭据托管,导不了', 'no-credential');
    }
    tokenSource = createManagedToken({
      store: storeFor(ctx),
      scope: connectionScope(kind, ctx?.ownership ?? null),
      clientId,
      clientSecret,
      ...(ctx?.oauthFetch ? { fetchImpl: ctx.oauthFetch } : {}),
    });
  }

  const provider = createStorageProvider({ kind, token: tokenSource, ...(ctx?.fetchImpl ? { fetchImpl: ctx.fetchImpl } : {}) });
  return importFromStorage({
    provider,
    fileId,
    name,
    tmpDir: ctx?.tmpDir || pullTmpDir(env),
    origin: ctx.origin,
    ticket: ctx?.ticket ?? null,
    ownership: ctx?.ownership ?? null,
    onProgress: ctx?.onProgress ?? null,
  });
}

/** A2:页面交来授权码,换出 refresh token 存起来。回包里不带任何令牌 */
export async function handleConnect(body, ctx) {
  const kind = checkKind(String(body?.kind || ''));
  const code = body?.code;
  const codeVerifier = body?.codeVerifier;
  if (typeof code !== 'string' || !code) throw new StorageConnectorError('请求里没有授权码', 'bad-request');
  if (typeof codeVerifier !== 'string' || !codeVerifier) throw new StorageConnectorError('请求里没有 PKCE verifier', 'bad-request');

  const env = ctx?.env ?? process.env;
  const { clientId, clientSecret, redirectUri } = oauthConfig(env);
  if (!clientId || !clientSecret || !redirectUri) {
    throw new StorageConnectorError('这台机器没配好凭据托管(客户端密钥或重定向地址)', 'not-configured');
  }
  return connectWithCode({
    store: storeFor(ctx),
    scope: connectionScope(kind, ctx?.ownership ?? null),
    code,
    codeVerifier,
    clientId,
    clientSecret,
    redirectUri,
    ...(ctx?.oauthFetch ? { fetchImpl: ctx.oauthFetch } : {}),
  });
}

/** A2:列出已连接的网盘。只回元信息,一个令牌都不带 */
export async function handleConnections(ctx) {
  const scope = connectionScope('google-drive', ctx?.ownership ?? null);
  const rows = await storeFor(ctx).list({ projectId: scope.projectId, userId: scope.userId });
  return { ok: true, connections: rows };
}

/** A2:断开。向网盘撤销,并删掉存着的那份;撤销没成也删,回包里说明原因 */
export async function handleDisconnect(body, ctx) {
  const kind = checkKind(String(body?.kind || ''));
  return disconnect({
    store: storeFor(ctx),
    scope: connectionScope(kind, ctx?.ownership ?? null),
    ...(ctx?.oauthFetch ? { fetchImpl: ctx.oauthFetch } : {}),
  });
}

/**
 * 授权弹窗落地页。把地址里的 `code` / `error` postMessage 回开它的那个页面,然后自己关掉。
 *
 * **只发给同源的开启方**(`postMessage(..., location.origin)`),授权码不会漏给别的源。
 * 页面上不显示授权码。
 */
export function callbackHtml() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>授权完成</title>
<style>body{font:14px system-ui,"Microsoft YaHei",sans-serif;color:#e8e8ea;background:#17181a;display:grid;place-items:center;height:100vh;margin:0}</style>
</head><body>
<p id="m">授权完成，正在返回…</p>
<script>
(function () {
  var q = new URLSearchParams(location.search);
  var msg = { source: 'promptcut-oauth', code: q.get('code'), state: q.get('state'), error: q.get('error') };
  try {
    if (window.opener) { window.opener.postMessage(msg, location.origin); window.close(); }
    else { document.getElementById('m').textContent = '这个窗口不是从编辑器打开的，直接关掉就行。'; }
  } catch (e) {
    document.getElementById('m').textContent = '返回编辑器时出错：' + e;
  }
})();
</script>
</body></html>`;
}
