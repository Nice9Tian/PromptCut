/**
 * 本地接口的同源守卫。
 *
 * # 为什么本地服务也需要这个
 *
 * 这个 sidecar 监听 127.0.0.1,很容易觉得「只有自己人能访问」。不是的:
 * **用户浏览器里任何一个网页都能往 127.0.0.1 发请求**。跨源的 XHR 读不到响应体
 * (浏览器的同源策略挡的是「读」),但**请求本身照发不误,副作用一样发生** ——
 * 只要它是一个「简单请求」(GET / HEAD,或者 POST 且 Content-Type 是
 * text/plain、application/x-www-form-urlencoded、multipart/form-data 三者之一),
 * 就不会有预检,服务端拦不住。
 *
 * 实际被这一条打穿的例子(0.3.0 评审抓到的):恶意页面往 `/api/ai/config` 发一个
 * `Content-Type: text/plain` 的 POST,body 是 `{"api":{"baseUrl":"https://攻击者"}}`。
 * writeConfig 是局部合并,payload 里没有 apiKey 就沿用旧的 —— 于是用户真实的 API Key
 * 被原样保留,下一次对话时连着 Key 一起打到攻击者的服务器上。攻击者从头到尾不需要
 * 读到任何一个响应。
 *
 * # 两道,一起用
 *
 * 1. **Origin**:跨源的 POST 浏览器一定会带 Origin,值和本站对不上就拒。
 * 2. **Content-Type 必须是 application/json**:这一条不属于简单请求,浏览器会先发
 *    预检 OPTIONS,而我们不回 CORS 头,预检就过不去 —— 于是跨源请求**连打都打不进来**。
 *    这道比第 1 道更硬:它不依赖 Origin 头存在。
 *
 * 没有 Origin 的请求放行,是有意的:同源的 GET、以及 curl / 自家 sidecar / MCP 脚本
 * 都不带 Origin。CSRF 讲的是「浏览器替用户发的请求」,而浏览器发跨源 POST 时必带 Origin。
 */
import path from "node:path";

/** 同源?没有 Origin 头当自己人(curl、sidecar、同源 GET 都不带) */
export function originOk(req) {
  const origin = req.headers?.origin;
  if (!origin) return true;
  const host = req.headers?.host;
  return origin === "http://" + host || origin === "https://" + host;
}

/** Content-Type 是不是 application/json(带 charset 也算) */
export function jsonContentType(req) {
  const ct = String(req.headers?.["content-type"] || "").toLowerCase();
  return ct.startsWith("application/json");
}

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * 守住一个接口。放行返回 true;拦下的话**已经把 403 发出去了**,调用方直接 return。
 *
 * 用法:`if (!guard(req, res)) return;` 放在每个 /api 处理函数的第一行。
 *
 * @param {object} opts
 *   - `json`:是否强制 application/x-www 之外的 JSON 类型。默认「写方法才要求」。
 *     上传文件那种 body 不是 JSON 的接口传 `json: false`,那时只剩 Origin 这一道。
 */
export function guard(req, res, opts = {}) {
  const method = String(req.method || "GET").toUpperCase();
  const wantJson = opts.json ?? WRITE_METHODS.has(method);

  if (!originOk(req)) {
    return deny(res, "跨源请求被拒绝");
  }
  if (wantJson && WRITE_METHODS.has(method) && !jsonContentType(req)) {
    // 不是浏览器发的(比如 curl 忘了带头)也一并拦:这道门槛的意义就在于「简单请求进不来」,
    // 留个后门等于没设。自家代码全部走 JSON。
    return deny(res, "这个接口只接受 Content-Type: application/json");
  }
  return true;
}

function deny(res, error) {
  if (!res.headersSent) {
    res.statusCode = 403;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify({ ok: false, error }));
  }
  return false;
}

/**
 * 一个路径是不是落在允许的根目录里面。
 *
 * 用 path.resolve 之后比较,并且要求下一个字符是分隔符 —— 只用 startsWith 会把
 * `C:\a\projects-evil` 判成在 `C:\a\projects` 里面。同名的目录本身算在内。
 * Windows 上大小写不敏感。
 */
export function isInside(child, parent) {
  const norm = (p) => {
    const r = path.resolve(p);
    return process.platform === "win32" ? r.toLowerCase() : r;
  };
  const c = norm(child);
  const p = norm(parent);
  if (c === p) return true;
  return c.startsWith(p.endsWith(path.sep) ? p : p + path.sep);
}

/** 落在**任意一个**允许的根目录里就算数 */
export function isInsideAny(child, parents) {
  return parents.some((p) => p && isInside(child, p));
}
