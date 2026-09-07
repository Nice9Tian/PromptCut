/**
 * 诊断报告收集端(Cloudflare Worker)。
 *
 * 三件事:
 *   1. 接住 PromptCut 前端 POST 过来的报告,存进 KV;
 *   2. 往飞书群里发一行摘要 + 取报告的链接 —— 飞书机器人发不了文件,
 *      几百 KB 的 JSON 直接贴过去会刷屏,所以群里只放摘要;
 *   3. 用 ADMIN_KEY 把取报告和列表这两个口守住。**ADMIN_KEY 只留在 Worker 和收件箱 GUI 里,
 *      永远不出现在发出去的链接里** —— 群里那条链接带的是单份报告的只读取件码
 *      (HMAC(ADMIN_KEY, id)),读不了别的报告,也列不了、删不了。
 *
 * 为什么用 KV 不用 R2:R2 即使只用免费额度也要求账号先绑卡,KV 不用。
 * 单值上限 25MB,而前端 SUBMIT_LIMIT 是 4MB,够。
 *
 * 部署见同目录 README.md。
 */

/** 收多大的报告。比前端的 4MB 略松一点,挡住明显不正常的请求就行 */
const MAX_BYTES = 6 * 1024 * 1024;

/*
 * 报告**不设过期**。
 *
 * 原来挂了 90 天的 TTL,想的是「不用手动打扫」。但那等于替人决定了
 * 「只有近期的报告有用」—— 隔半年回头对一个老问题,东西已经自己删没了。
 * 该不该删由收件箱里的删除按钮决定,不由计时器决定。
 *
 * KV 免费额度 1GB。真堆满了再谈清理,而不是提前替人做主。
 */

/** 列表一页最多列多少条。1000 是 KV list 的上限,客户端拿游标翻完为止 */
const LIST_LIMIT = 1000;

/**
 * 单份报告的只读取件码。**飞书群里发的是它,不是 ADMIN_KEY。**
 *
 * 原来发的链接是 `/r/<id>?k=<ADMIN_KEY>` —— 那是管理密钥,能取任意一份、能列全部、能删。
 * 群里每个人、每一张转发出去的截图,拿到的都是这把总钥匙。
 *
 * 换成 HMAC(ADMIN_KEY, id):每份报告一个码,只能读它自己那一份,列不了也删不了。
 * ADMIN_KEY 始终留在 Worker 里,只有收件箱 GUI 手上有。
 *
 * (要更严可以在签名里混进签发时间做成限时链接。这里没做:报告是**故意不过期**的,
 * 半年后回头查同一个问题时链接还得能用。)
 */
async function readToken(adminKey, id) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', enc.encode(adminKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(id)));
  // base64url,截前 128 bit —— 够抗爆破,又不至于让链接长得没法看
  return btoa(String.fromCharCode(...sig.slice(0, 16))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** 定长比较,别让比较耗时把答案漏出去 */
function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/**
 * 限流。用 Cloudflare 的 Rate limiting 绑定(在边缘按 key 计数,不花 KV 写额度)。
 *
 * 没配这个绑定就直接放行 —— 老部署不该因为少一个绑定就整个挂掉,
 * 但 wrangler.jsonc 里已经写好了,重新 deploy 一次就生效。
 */
async function allow(env, key) {
  try {
    if (!env.SUBMIT_LIMIT?.limit) return true;
    const { success } = await env.SUBMIT_LIMIT.limit({ key });
    return success !== false;
  } catch {
    return true; // 限流器自己出问题不该把收报告这件事也挡掉
  }
}

function cors(res) {
  // 前端用 text/plain 发,属于 CORS 简单请求,不会有预检;
  // 但要让浏览器读到回执 id,响应头还是得给。
  res.headers.set('Access-Control-Allow-Origin', '*');
  return res;
}

function json(data, status = 200) {
  return cors(new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json;charset=utf-8' },
  }));
}

/** 摘要:从报告正文里挑几条能在群里一眼看懂的 */
function digest(payload) {
  const bits = [];
  try {
    const server = payload.server || {};
    if (payload.currentProvider) bits.push(`驱动 ${payload.currentProvider}`);
    if (server.machineCode) bits.push(server.machineCode);
    if (server.app?.platform) bits.push(server.app.platform);
    // notable 是前端挑好的「和默认值不一样、最容易让人查错方向」的几条,
    // 带 ⚠ 的那几条最值得在群里直接看到
    const warn = (payload.notable || []).filter((s) => typeof s === 'string' && s.includes('⚠'));
    bits.push(...warn.slice(0, 2));
  } catch { /* 报告结构对不上就只发基本信息,不因为摘要失败丢掉整份报告 */ }
  return bits;
}

async function notifyFeishu(env, { id, label, size, payload, link }) {
  if (!env.FEISHU_WEBHOOK) return;
  const lines = [
    `【${label || '诊断报告'}】${(size / 1024).toFixed(0)}KB`,
    ...digest(payload),
    `取报告：${link}`,
  ];
  try {
    await fetch(env.FEISHU_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text: lines.join('\n') } }),
    });
  } catch { /* 飞书发不出去不算收报告失败,报告已经在 KV 里了 */ }
  void id;
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    const ip = req.headers.get('cf-connecting-ip') || '';
    const isAdminPath = url.pathname === '/list' || url.pathname.startsWith('/r/');
    // 管理口按 IP 限流:这几条是拿密钥当门的,不限流等于给爆破无限次机会
    if (isAdminPath && !(await allow(env, `admin:${ip}`))) {
      return new Response('slow down', { status: 429 });
    }

    // ---- 取一份报告:GET /r/<id>?k=<ADMIN_KEY> 或 ?s=<单份取件码> ----
    if (req.method === 'GET' && url.pathname.startsWith('/r/')) {
      const id = url.pathname.slice(3);
      if (!env.ADMIN_KEY) return new Response('nope', { status: 404 });
      const byAdmin = sameSecret(url.searchParams.get('k') || '', env.ADMIN_KEY);
      const byToken = sameSecret(url.searchParams.get('s') || '', await readToken(env.ADMIN_KEY, id));
      if (!byAdmin && !byToken) return new Response('nope', { status: 404 });
      const body = await env.REPORTS.get(id);
      if (!body) return new Response('not found', { status: 404 });
      // 这条**不加** Access-Control-Allow-Origin:报告正文不该被任意网页跨站读走
      return new Response(body, { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    }

    // ---- 删一份:DELETE /r/<id>?k=<ADMIN_KEY> ----(取件码没有删除权)
    if (req.method === 'DELETE' && url.pathname.startsWith('/r/')) {
      if (!env.ADMIN_KEY || !sameSecret(url.searchParams.get('k') || '', env.ADMIN_KEY)) {
        return new Response('nope', { status: 404 });
      }
      await env.REPORTS.delete(url.pathname.slice(3));
      return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json;charset=utf-8' } });
    }

    // ---- 列最近的:GET /list?k=<ADMIN_KEY> ----(取件码没有列表权)
    if (req.method === 'GET' && url.pathname === '/list') {
      if (!env.ADMIN_KEY || !sameSecret(url.searchParams.get('k') || '', env.ADMIN_KEY)) {
        return new Response('nope', { status: 404 });
      }
      const cursor = url.searchParams.get('cursor') || undefined;
      // limit 可以调小,主要是给「翻页翻得对不对」这种自检用;上限还是 LIST_LIMIT
      const asked = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, LIST_LIMIT) : LIST_LIMIT;
      const out = await env.REPORTS.list({ limit, cursor });
      // 同样不给 Access-Control-Allow-Origin:清单里有机器码、IP、标签,别让网页跨站读走
      return new Response(JSON.stringify({
        ok: true,
        keys: out.keys.map((k) => ({ id: k.name, ...k.metadata })),
        cursor: out.list_complete ? null : out.cursor,
      }), { headers: { 'Content-Type': 'application/json;charset=utf-8' } });
    }

    if (req.method !== 'POST') return cors(new Response('POST only', { status: 405 }));

    // 收报告也按 IP 限流:令牌是随前端打包发出去的,公开可得,光靠它挡不住灌数据
    if (!(await allow(env, `submit:${ip}`))) {
      return json({ ok: false, error: '提交太频繁,过一会儿再试' }, 429);
    }

    // ---- 收报告 ----
    const raw = await req.text();
    if (raw.length > MAX_BYTES) return json({ ok: false, error: '报告太大' }, 413);

    let payload;
    try { payload = JSON.parse(raw); } catch { return json({ ok: false, error: '不是 JSON' }, 400); }

    /*
     * 令牌。它跟着前端打包发出去,所以拦不住铁了心要灌数据的人 ——
     * 它挡的是「地址被人扫到,随手 curl 一下」。真要防滥用,在 Cloudflare 后台
     * 给这条路由加一条 Rate limiting 规则,那个是按 IP 在边缘上算的。
     */
    if (env.SUBMIT_TOKEN && !sameSecret(String(payload.token || ''), env.SUBMIT_TOKEN)) {
      return json({ ok: false, error: '令牌不对' }, 403);
    }
    // 存之前必须把令牌摘掉,而且**存重新序列化的那份**,不是原始 raw ——
    // 存 raw 的话令牌原样留在报告里,而报告链接是要发进飞书群的,
    // 等于把提交令牌发给群里每个人。
    delete payload.token;
    const stored = JSON.stringify(payload);

    const id = `${new Date().toISOString().slice(0, 10)}-${crypto.randomUUID().slice(0, 8)}`;
    const meta = {
      label: String(payload.label || '诊断报告').slice(0, 40),
      at: payload.at || new Date().toISOString(),
      size: stored.length,
      ip: req.headers.get('cf-connecting-ip') || '',
    };
    await env.REPORTS.put(id, stored, { metadata: meta });

    // 群里发的是**这一份**的只读取件码,不是管理密钥。见 readToken 上面的说明
    const link = env.ADMIN_KEY
      ? `${url.origin}/r/${id}?s=${await readToken(env.ADMIN_KEY, id)}`
      : `${url.origin}/r/${id}`;
    await notifyFeishu(env, { id, label: meta.label, size: stored.length, payload, link });

    return json({ ok: true, id });
  },
};
