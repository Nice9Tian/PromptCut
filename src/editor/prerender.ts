import { useEffect, useState } from "react";

/**
 * 预渲染进程的地址(docs/decoupling-plan.md 第 3 节「预渲染」)。
 *
 * 编辑器页面里**挂得久**的请求 —— 3D 视图的空闲预烘、聊天栏里的动图、导出进度 —— 直接发到
 * 预渲染那个源上,不走编辑器自己的源。原因是浏览器对同一个源只开约 6 条 HTTP/1.1 连接:
 * 这些请求一挂几秒到几分钟,挤在编辑器的源上会把连接占满,之后编辑器要加载的模块、素材、
 * 接口全部排队,界面卡死而 CPU 一点都不忙(实测轻请求要等 7.7 秒)。
 *
 * 预渲染还没起来(或者这是个老的 dev server、没有 /api/prerender/info)就退回同源 ——
 * 慢一点,但功能照旧。
 */

let base: string | null = null;
let asking: Promise<string> | null = null;

async function ask(): Promise<string> {
  // 起预渲染要一两秒(首次预构建依赖更久):没就绪就多问几次,还不行就先用同源
  for (let i = 0; i < 20; i++) {
    try {
      const r = await fetch("/api/prerender/info", { cache: "no-store" });
      if (!r.ok) return "";
      const d = await r.json();
      if (d?.ready && typeof d.url === "string") return d.url;
    } catch {
      return "";
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return "";
}

/** 预渲染的源(`http://127.0.0.1:端口`);拿不到时是空串,也就是同源 */
export async function prerenderBase(): Promise<string> {
  if (base !== null) return base;
  if (!asking) {
    asking = ask().then((u) => {
      // 同源兜底不缓存:预渲染晚一点起来,下一次还能换到它上面去
      if (u) base = u;
      asking = null;
      return u;
    });
  }
  return asking;
}

/** 把一个 /api/... 路径换成预渲染上的完整地址 */
export async function prerenderUrl(path: string): Promise<string> {
  return (await prerenderBase()) + path;
}

/**
 * 给 <img src> 这类同步场合用:先渲同源地址,拿到预渲染的源之后换过去。
 * 返回的是一个前缀,拼在 /api/... 前面用。
 */
export function usePrerenderBase(): string {
  const [b, setB] = useState(base ?? "");
  useEffect(() => {
    let live = true;
    prerenderBase().then((u) => { if (live) setB(u); });
    return () => { live = false; };
  }, []);
  return b;
}

/** 把相对地址(/api/ai/visual/...)前缀上预渲染的源;已经是绝对地址的原样返回 */
export function withBase(b: string, url: string): string {
  return url.startsWith("/") ? b + url : url;
}
