import type { PickedFile, StorageProviderConfig } from "./storageImport";

/**
 * Google 的授权与选文件(任务书 `docs/plan/drive-connector-task.md` 第 5 节)。
 *
 * 这里只做两件事:**拿一张一小时的 access token**,和**让用户选文件**。拿到的 token 和文件 id 交给
 * 编辑器进程(`/api/media/storage/import`),字节由它去拉 —— 页面不碰字节。
 *
 * # 为什么只要 `drive.file`
 *
 * 这个范围只能碰用户当场在 Picker 里选中的文件,搜不了他整个网盘。它是**非敏感**范围,不触发 Google
 * 每年一次的第三方安全评估;`drive.readonly` 是受限范围,要评估。2026-10-23 的 D1 探针实测过
 * 「选中即授权」成立(任务书第 6.1 节)。**不要往这里加范围。**
 *
 * # 这是 A3「短命票」那条路
 *
 * 这张 token 一小时就过期,用完即弃,不保存。关掉页面没传完的,下次打开重新授权再续。
 * A2(把长期授权交给云端保管)是另一条路,不走这里。
 *
 * # 两个脚本
 *
 * `accounts.google.com/gsi/client` 管授权,`apis.google.com/js/api.js` 管 Picker。两个都按需注入、只注入一次。
 */

/** Google 的全局对象,没有类型声明,统一用 any 接 */
declare global {
  interface Window {
    google?: any;
    gapi?: any;
  }
}

const GIS_SRC = "https://accounts.google.com/gsi/client";
const GAPI_SRC = "https://apis.google.com/js/api.js";
/** 脚本加载与用户操作的上限。授权窗口是用户在点,给宽一点 */
const SCRIPT_TIMEOUT_MS = 20_000;

const loading = new Map<string, Promise<void>>();

function loadScript(src: string): Promise<void> {
  const existing = loading.get(src);
  if (existing) return existing;
  const p = new Promise<void>((resolve, reject) => {
    const el = document.createElement("script");
    el.src = src;
    el.async = true;
    el.defer = true;
    const timer = setTimeout(() => reject(new Error(`加载 ${src} 超时,检查网络`)), SCRIPT_TIMEOUT_MS);
    el.onload = () => { clearTimeout(timer); resolve(); };
    el.onerror = () => { clearTimeout(timer); reject(new Error(`加载 ${src} 失败,检查网络`)); };
    document.head.appendChild(el);
  });
  loading.set(src, p);
  return p;
}

/** 等某个全局对象出现(脚本 onload 之后它才挂上去) */
function waitFor<T>(get: () => T | undefined, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const v = get();
      if (v) return resolve(v);
      if (Date.now() - started > SCRIPT_TIMEOUT_MS) return reject(new Error(`${what} 没有就绪`));
      setTimeout(tick, 60);
    };
    tick();
  });
}

async function ensureGis(): Promise<any> {
  await loadScript(GIS_SRC);
  return waitFor(() => window.google?.accounts?.oauth2, "Google 授权脚本");
}

async function ensurePicker(): Promise<any> {
  await loadScript(GAPI_SRC);
  const gapi = await waitFor(() => window.gapi, "Google API 脚本");
  if (!window.google?.picker) {
    await new Promise<void>((resolve, reject) => {
      try { gapi.load("picker", { callback: () => resolve(), onerror: () => reject(new Error("Picker 模块没载入")) }); }
      catch (e) { reject(e); }
    });
  }
  return waitFor(() => window.google?.picker, "Google Picker");
}

/** 一张短命票。`expiresAt` 是本地时钟的毫秒时间戳,只用来判断要不要重新要一张 */
export interface DriveToken {
  token: string;
  expiresAt: number;
  /** Google 实际给到的范围。只申请 drive.file 时它还会附送几个非敏感的 OIDC 基本范围 */
  scope: string;
}

let cached: DriveToken | null = null;
/** 提前这么久就当它过期,免得正用着过期 */
const EXPIRY_MARGIN_MS = 5 * 60 * 1000;

/** 要一张 access token。手里那张还够用就直接给,不再弹窗 */
export async function getDriveToken(cfg: StorageProviderConfig, { force = false } = {}): Promise<DriveToken> {
  if (!force && cached && cached.expiresAt - EXPIRY_MARGIN_MS > Date.now()) return cached;
  if (!cfg.clientId) throw new Error("没有 OAuth 客户端 ID,服务端还没配好");
  const oauth2 = await ensureGis();
  const scope = cfg.scope || "https://www.googleapis.com/auth/drive.file";

  const got = await new Promise<DriveToken>((resolve, reject) => {
    const client = oauth2.initTokenClient({
      client_id: cfg.clientId,
      scope,
      callback: (resp: any) => {
        if (resp?.error) return reject(new Error(`授权没通过:${resp.error_description || resp.error}`));
        if (!resp?.access_token) return reject(new Error("授权回包里没有 access token"));
        resolve({
          token: String(resp.access_token),
          expiresAt: Date.now() + (Number(resp.expires_in) || 3600) * 1000,
          scope: String(resp.scope || scope),
        });
      },
      error_callback: (err: any) => reject(new Error(`授权窗口关闭或被拦:${err?.type || "未知原因"}`)),
    });
    client.requestAccessToken();
  });

  cached = got;
  return got;
}

/** 手动把手里那张票作废(换账号、撤销授权之后) */
export function forgetDriveToken(): void {
  cached = null;
}

/**
 * 打开 Picker 让用户选。取消返回 `null`(不是错误)。
 *
 * 必须带 `setAppId`(Cloud 项目编号):`drive.file` 的「按文件授权」是记在这个应用名下的,不给就选了也读不到。
 */
export async function pickDriveFiles(cfg: StorageProviderConfig, token: string): Promise<PickedFile[] | null> {
  if (!cfg.apiKey) throw new Error("没有 API 密钥,服务端还没配好");
  if (!cfg.appId) throw new Error("没有 Cloud 项目编号,Picker 的按文件授权记不上账");
  const picker = await ensurePicker();

  return new Promise<PickedFile[] | null>((resolve, reject) => {
    try {
      const views = [
        new picker.DocsView(picker.ViewId.DOCS_VIDEOS).setIncludeFolders(true),
        new picker.DocsView(picker.ViewId.DOCS_IMAGES).setIncludeFolders(true),
        new picker.DocsView(picker.ViewId.DOCS).setIncludeFolders(true),
      ];
      const builder = new picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(cfg.apiKey)
        .setAppId(cfg.appId)
        .enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .setCallback((data: any) => {
          if (data.action === picker.Action.CANCELLED) return resolve(null);
          if (data.action !== picker.Action.PICKED) return;
          const docs = Array.isArray(data.docs) ? data.docs : [];
          resolve(docs.map((d: any): PickedFile => ({
            id: String(d.id),
            name: String(d.name || d.id),
            mimeType: d.mimeType ? String(d.mimeType) : undefined,
            sizeBytes: Number(d.sizeBytes) || undefined,
          })));
        });
      for (const v of views) builder.addView(v);
      builder.build().setVisible(true);
    } catch (e) {
      reject(e instanceof Error ? e : new Error(String(e)));
    }
  });
}
