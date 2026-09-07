import type { Plugin, ViteDevServer } from 'vite';
import type { ServerResponse } from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

/**
 * 建卡端点。
 *
 * AI 的文件工具被锁在 exports/ai-workspace/ 里(见 harness/tools/textEditor.mjs),
 * 够不到 src/cards/。这个端点是唯一的口子,而且只开到 src/cards/user/ 这一个目录、
 * 只允许 .tsx、一次一个文件 —— 建卡不该顺带获得改整个代码库的能力。
 *
 * 桌面版跑的是真的 vite dev server(见 desktop/src-tauri/src/lib.rs),
 * 所以文件落盘后 HMR 会直接编译加载,不需要重启也不需要重新打包。
 */

const MAX_SOURCE_BYTES = 64 * 1024;
/** kebab-case,且不能以 mu- 开头(那是 Magic UI 的前缀) */
const ID_RE = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(data));
}

/** 只认同源请求,和 ai 那几个写端点一致 */
function originOk(req: { headers: Record<string, any> }): boolean {
  const origin = req.headers.origin;
  if (!origin) return true;
  return origin === 'http://' + req.headers.host || origin === 'https://' + req.headers.host;
}

export interface CardCheck {
  ok: boolean;
  errors: string[];
}

/**
 * 落盘前的静态检查。这里挡住的是「写进去就会让编辑器白屏」的几类错误,
 * 剩下的运行时问题交给 vite 的编译报错和用户预览。
 */
export function checkCardSource(id: string, source: string, existingIds: string[]): CardCheck {
  const errors: string[] = [];

  if (!ID_RE.test(id)) {
    errors.push(`卡片 id "${id}" 不合法:要用小写 kebab-case(例如 my-title-card),只能有字母、数字和连字符。`);
  }
  if (id.startsWith('mu-')) {
    errors.push('mu- 前缀留给 Magic UI 适配卡,换一个 id。');
  }
  if (existingIds.includes(id)) {
    errors.push(`已经有 id 为 "${id}" 的卡片了。卡片 id 必须唯一,换一个;想改现有的卡请直接改它的文件。`);
  }
  if (Buffer.byteLength(source, 'utf8') > MAX_SOURCE_BYTES) {
    errors.push(`源码超过 ${MAX_SOURCE_BYTES / 1024}KB,太大了。`);
  }

  // 必须真的导出一个 CardDef,否则 glob 收集时会静默跳过,建了个寂寞
  if (!/export\s+const\s+\w+\s*:\s*CardDef/.test(source)) {
    errors.push('源码里没有 `export const xxx: CardDef<Params> = { ... }` 形式的具名导出 —— 自动注册靠它识别卡片。');
  }
  const idInSource = source.match(/\bid:\s*["'`]([^"'`]+)["'`]/);
  if (!idInSource) {
    errors.push('CardDef 里没有 id 字段。');
  } else if (idInSource[1] !== id) {
    errors.push(`CardDef 里的 id 是 "${idInSource[1]}",和传进来的 id "${id}" 不一致,两者必须相同。`);
  }
  for (const field of ['name', 'description', 'defaults', 'controls', 'Component']) {
    if (!new RegExp(`\\b${field}\\s*:`).test(source)) {
      errors.push(`CardDef 里缺少 ${field} 字段。`);
    }
  }

  // 这几条是硬约束:导出时用的是虚拟时钟,拿真实时间的卡导出会不同步
  if (/\bDate\.now\s*\(/.test(source)) {
    errors.push('不要用 Date.now():导出时走的是虚拟时间,会和画面对不上。动画交给 motion/react,需要读时间就用组件收到的 t。');
  }
  if (/\bsetTimeout\s*\(|\bsetInterval\s*\(/.test(source)) {
    errors.push('不要用 setTimeout / setInterval 驱动动画:导出时它们不受虚拟时钟控制。用 motion/react 的 animate,或读组件参数 t。');
  }
  if (/\bIntersectionObserver\b/.test(source)) {
    errors.push('不要用 IntersectionObserver:卡片挂载即播放,不存在「滚动进入视口」这回事。');
  }

  // 语法检查:让写坏的文件在这里就被挡住,而不是存进去把 HMR 打挂
  const out = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { jsx: ts.JsxEmit.Preserve, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext },
  });
  for (const d of out.diagnostics || []) {
    const msg = ts.flattenDiagnosticMessageText(d.messageText, ' ');
    const pos = d.start !== undefined ? source.slice(0, d.start).split('\n').length : undefined;
    errors.push(`语法错误${pos ? `(第 ${pos} 行)` : ''}:${msg}`);
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 把一次 find/replace 应用到源码上。
 *
 * 独立成纯函数不是为了复用,是为了能测:命中次数、$ 记号、空改这几种情形出错时
 * 都不会报错,只会静静地把文件改成别的样子 —— 那正是这个功能要根治的毛病。
 */
export function applyCardPatch(
  before: string,
  find: string,
  replace: string,
  replaceAll?: boolean,
): { ok: true; after: string; replaced: number } | { ok: false; error: string } {
  if (!find) return { ok: false, error: 'find 不能是空串,那会匹配到每一个位置。' };

  const hits = before.split(find).length - 1;
  if (hits === 0) {
    return {
      ok: false,
      error: 'find 在源码里一次都没匹配到 —— 你手上的版本和文件里的对不上。先调 get_card_source 读回当前源码,照着它写 find(缩进和空格都要一致)。',
    };
  }
  if (hits > 1 && !replaceAll) {
    return {
      ok: false,
      error: `find 匹配到 ${hits} 处,分不清要改哪一处。把 find 写长一点、带上周围几行让它唯一;确实要全改就传 replaceAll: true。`,
    };
  }

  // 用 split/join 而不是 String.replace:后者会把 replace 里的 $& $` $' $$ 当成
  // 「引用匹配内容」的替换记号展开,而这里的 replace 是模型逐字写好的源码,必须原样落盘。
  const after = before.split(find).join(replace);
  if (after === before) {
    return { ok: false, error: 'replace 和 find 完全一样,这次编辑什么都没改。' };
  }
  return { ok: true, after, replaced: hits };
}

export default function vitePluginCards(): Plugin {
  return {
    name: 'promptcut-cards',
    configureServer(server: ViteDevServer) {
      const userDir = path.join(server.config.root, 'src', 'cards', 'user');

      // 建卡规则单独用一个端点按需取,而不是塞进每次对话的系统提示里 ——
      // 它只在「要建新卡」时才用得上,常驻会白白占掉几千 token。
      server.middlewares.use('/api/cards/guide', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        try {
          const guide = fs.readFileSync(new URL('./card-authoring-guide.md', import.meta.url), 'utf-8');
          res.statusCode = 200;
          res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
          res.end(guide);
        } catch (e: any) {
          sendJson(res, 500, { ok: false, error: e?.message || String(e) });
        }
      });

      /**
       * 读回一张用户卡的当前源码。
       *
       * 没有这个口子的时候,改卡只能走 create_card + overwrite —— 那是整篇重写,
       * 模型手上没有当前版本,只能凭记忆重建,没被提到的细节每轮都会漂。
       * 先读回来,才谈得上「改」。只开到 user 目录:内置卡改参数就够了,不该被改源码。
       */
      server.middlewares.use('/api/cards/source', (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'GET only' });
        const id = new URL(req.url || '', 'http://x').searchParams.get('id') || '';
        if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `卡片 id "${id}" 不合法。` });
        const target = path.join(userDir, `${id}.tsx`);
        if (path.dirname(path.resolve(target)) !== path.resolve(userDir)) {
          return sendJson(res, 400, { ok: false, error: '非法的文件路径' });
        }
        if (!fs.existsSync(target)) {
          return sendJson(res, 404, {
            ok: false,
            error: `src/cards/user/${id}.tsx 不存在。内置卡没有单独可读的源码文件,想调整内置卡请改它的参数(list_cards 看 schema,update_clip 改值)。`,
          });
        }
        const source = fs.readFileSync(target, 'utf8');
        sendJson(res, 200, { ok: true, id, file: `src/cards/user/${id}.tsx`, source, lines: source.split('\n').length });
      });

      /**
       * 局部替换式改卡:给一段 find、一段 replace,只动那一处。
       *
       * 相对 create_card + overwrite 的意义不在省字数,在于**没提到的地方一定不变**。
       * 所以 find 必须唯一命中:命中 0 次说明调用方手上的版本是旧的,命中多次说明
       * 它想改哪一处根本没说清 —— 两种都该报错让它先读回源码,而不是替它猜。
       */
      server.middlewares.use('/api/cards/edit', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });

        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_SOURCE_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          try {
            const { id, find, replace, replaceAll } = JSON.parse(body || '{}');
            if (typeof id !== 'string' || typeof find !== 'string' || typeof replace !== 'string') {
              return sendJson(res, 400, { ok: false, error: 'id、find、replace 都必须是字符串' });
            }
            if (!ID_RE.test(id)) return sendJson(res, 400, { ok: false, error: `卡片 id "${id}" 不合法。` });

            const target = path.join(userDir, `${id}.tsx`);
            if (path.dirname(path.resolve(target)) !== path.resolve(userDir)) {
              return sendJson(res, 400, { ok: false, error: '非法的文件路径' });
            }
            if (!fs.existsSync(target)) {
              return sendJson(res, 404, { ok: false, error: `src/cards/user/${id}.tsx 不存在,edit_card 只能改用 create_card 建出来的卡。` });
            }

            const before = fs.readFileSync(target, 'utf8');
            const patch = applyCardPatch(before, find, replace, replaceAll === true);
            if (!patch.ok) return sendJson(res, 400, { ok: false, error: patch.error });
            const { after, replaced } = patch;

            // 和 create 走同一套校验:局部替换一样能把文件改到编译不过
            const check = checkCardSource(id, after, []);
            if (!check.ok) {
              return sendJson(res, 400, { ok: false, error: check.errors.join('\n'), errors: check.errors });
            }

            fs.writeFileSync(target, after, 'utf8');
            sendJson(res, 200, {
              ok: true,
              id,
              file: `src/cards/user/${id}.tsx`,
              replaced,
              source: after,
              hint: '已改写并热更新。改完用 see_preview 看一眼画面,再决定要不要接着调。',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });

      server.middlewares.use('/api/cards/create', async (req, res) => {
        if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'POST only' });
        if (!req.headers['content-type']?.startsWith('application/json')) {
          return sendJson(res, 415, { ok: false, error: 'JSON required' });
        }
        if (!originOk(req as any)) return sendJson(res, 403, { ok: false, error: 'Origin rejected' });

        let body = '';
        req.on('data', (c) => { body += c; if (body.length > MAX_SOURCE_BYTES * 2) req.destroy(); });
        req.on('end', () => {
          try {
            const { id, source, existingIds, overwrite } = JSON.parse(body || '{}');
            if (typeof id !== 'string' || typeof source !== 'string') {
              return sendJson(res, 400, { ok: false, error: 'id 和 source 都必须是字符串' });
            }

            fs.mkdirSync(userDir, { recursive: true });
            const target = path.join(userDir, `${id}.tsx`);
            // id 已经过 kebab-case 白名单,这里再确认一次落点没跑出 user 目录
            if (path.dirname(path.resolve(target)) !== path.resolve(userDir)) {
              return sendJson(res, 400, { ok: false, error: '非法的文件路径' });
            }

            const already = fs.existsSync(target);
            if (already && !overwrite) {
              // 这句话出现的时机,正是模型「想改一张已有的卡」的那一刻 —— 全仓库
              // 最该把它引到 edit_card 上的地方。原来这里写的是「传 overwrite: true」,
              // 等于在决策点上教它整篇重写。
              return sendJson(res, 409, {
                ok: false,
                error: `src/cards/user/${id}.tsx 已存在。要改它请用 get_card_source 读回源码、再用 edit_card 改那一处;确实要整张推倒重来才传 overwrite: true。`,
              });
            }

            const check = checkCardSource(id, source, Array.isArray(existingIds) && !already ? existingIds : []);
            if (!check.ok) {
              return sendJson(res, 400, { ok: false, error: check.errors.join('\n'), errors: check.errors });
            }

            fs.writeFileSync(target, source, 'utf8');
            sendJson(res, 200, {
              ok: true,
              id,
              file: `src/cards/user/${id}.tsx`,
              overwritten: already,
              // 把落盘后的源码原样回给调用方。少了这一步,模型下次想改这张卡时手上
              // 没有当前版本,只能凭记忆整篇重写 —— 实测那会让没被提到的细节每重写
              // 一次就漂一点(同一张卡的字号一路 42→56→42→32)。
              source,
              lines: source.split('\n').length,
              hint: '已写入并热更新。要再改它请用 edit_card 做局部替换,不要用 create_card 整篇重写。',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  };
}
