/**
 * 诊断报告收集端(Cloudflare Worker)。
 *
 * 三件事:
 *   1. 接住 PromptCut 前端 POST 过来的报告,存进 KV;
 *   2. 往飞书群里发一行摘要 + 取报告的链接 —— 飞书机器人发不了文件,
 *      几百 KB 的 JSON 直接贴过去会刷屏,所以群里只放摘要;
 *   3. 用 ADMIN_KEY 把取报告和列表这两个口守住。
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

    // ---- 取一份报告:GET /r/<id>?k=<ADMIN_KEY> ----
    if (req.method === 'GET' && url.pathname.startsWith('/r/')) {
      if (!env.ADMIN_KEY || url.searchParams.get('k') !== env.ADMIN_KEY) {
        return new Response('nope', { status: 404 });
      }
      const body = await env.REPORTS.get(url.pathname.slice(3));
      if (!body) return new Response('not found', { status: 404 });
      return new Response(body, { headers: { 'Content-Type': 'text/plain;charset=utf-8' } });
    }

    // ---- 删一份:DELETE /r/<id>?k=<ADMIN_KEY> ----
    if (req.method === 'DELETE' && url.pathname.startsWith('/r/')) {
      if (!env.ADMIN_KEY || url.searchParams.get('k') !== env.ADMIN_KEY) {
        return new Response('nope', { status: 404 });
      }
      await env.REPORTS.delete(url.pathname.slice(3));
      return json({ ok: true });
    }

    // ---- 列最近的:GET /list?k=<ADMIN_KEY> ----
    if (req.method === 'GET' && url.pathname === '/list') {
      if (!env.ADMIN_KEY || url.searchParams.get('k') !== env.ADMIN_KEY) {
        return new Response('nope', { status: 404 });
      }
      const cursor = url.searchParams.get('cursor') || undefined;
      // limit 可以调小,主要是给「翻页翻得对不对」这种自检用;上限还是 LIST_LIMIT
      const asked = Number(url.searchParams.get('limit'));
      const limit = Number.isFinite(asked) && asked > 0 ? Math.min(asked, LIST_LIMIT) : LIST_LIMIT;
      const out = await env.REPORTS.list({ limit, cursor });
      return json({
        ok: true,
        keys: out.keys.map((k) => ({ id: k.name, ...k.metadata })),
        cursor: out.list_complete ? null : out.cursor,
      });
    }

    if (req.method !== 'POST') return cors(new Response('POST only', { status: 405 }));

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
    if (env.SUBMIT_TOKEN && payload.token !== env.SUBMIT_TOKEN) {
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

    const link = `${url.origin}/r/${id}?k=${env.ADMIN_KEY || ''}`;
    await notifyFeishu(env, { id, label: meta.label, size: stored.length, payload, link });

    return json({ ok: true, id });
  },
};
