/**
 * 桌面版给 `accountPage.ts` 的本机采集与上传(只在有本机编辑器进程时用;在线构建不引用这些函数)。
 *
 * 云端 Agent 碰到要登录的站点时,经反向通道请**发消息的那个人自己的电脑**代下:这里把页面执行器(`collectBridge.ts`)要的
 * 那几样接到本机现成的接口上——查采集就绪、查登录态、起下载、查作业、取消、打开登录窗口、查登录结果,
 * 以及把下好的文件按哈希交给本机的上传队列、问素材服务里是不是齐了。登录态文件的路径只在本机的两个接口之间传,不出这台电脑;
 * 交回云端的字段由 `collectBridge.ts` 逐项拼,这里回的多余字段它不读。
 */
import { cancelDownload, collectLogin, collectLoginCheck, collectStatus, cookieStatus, pollDownload, startDownload } from "../collect";
import { openCollectLogin } from "../collectLoginStore";
import { askComplete } from "../../editor/media/assetTiers";
import type { CollectBridgeLocal, CollectBridgeUpload, LocalCollectJob } from "./collectBridge";

export function desktopCollectLocal(): CollectBridgeLocal {
  return {
    async status() { return { ready: (await collectStatus()).ready === true }; },
    async cookies() {
      const all = await cookieStatus();
      const out: Record<string, { loggedIn: boolean; path?: string | null }> = {};
      for (const [site, c] of Object.entries(all)) out[site] = { loggedIn: c.loggedIn === true && c.expired !== true, path: c.path };
      return out;
    },
    download: (url, opts) => startDownload(url, opts),
    async job(jobId) {
      // 本机的编辑器进程重启过就没有这个作业了:按「没有」回,页面执行器据此如实交回
      try { return (await pollDownload(jobId)) as unknown as LocalCollectJob; } catch { return null; }
    },
    cancel: (jobId) => cancelDownload(jobId),
    async login({ site, method, force }) {
      if (!force) {
        const current = (await cookieStatus())[site];
        if (current?.loggedIn === true && current.expired !== true) return { ok: true, alreadyLoggedIn: true };
      }
      // 扫码:弹本机现成的「站点登录」弹窗;网页登录:本机现成的登录窗口
      if (method === "qr") { openCollectLogin(site, "qr"); return { ok: true }; }
      const r = await collectLogin(site, force === true);
      return { ok: r.ok !== false, ...(r.alreadyLoggedIn ? { alreadyLoggedIn: true } : {}) };
    },
    async loginCheck({ site, hide }) {
      const r = await collectLoginCheck(site, hide !== false);
      return { ok: r.ok !== false, loggedIn: r.loggedIn === true, expired: r.expired === true };
    },
  };
}

/**
 * @param projectId 这张页面此刻开着的账号项目号(没有回 null)
 */
export function desktopCollectUpload(projectId: () => string | null): CollectBridgeUpload {
  return {
    projectId,
    async push(items) {
      // 编辑器进程的「按哈希入队」:本机内容库里有的才收,缺的回在 missing 里;上传目标是本机(没放云端)时回 local
      try {
        const r = await fetch("/api/media/upload-queue/enqueue", { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items: items.map((it) => ({ name: it.name, original: it.hash })) }) });
        const j = (await r.json()) as { ok?: boolean; missing?: string[]; local?: boolean };
        if (!j?.ok || j.local) return false;
        const missing = new Set((j.missing ?? []).map((h) => String(h).toLowerCase()));
        return items.every((it) => !missing.has(it.hash.toLowerCase()));
      } catch { return false; }
    },
    async stored(hash) { return (await askComplete([hash])).has(hash); },
  };
}
