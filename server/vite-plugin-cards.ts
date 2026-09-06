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
              return sendJson(res, 409, { ok: false, error: `src/cards/user/${id}.tsx 已存在。要改它就传 overwrite: true。` });
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
              hint: '已写入并热更新。用 list_cards({ cardId }) 确认它已注册,再 add_clip 放到时间轴上看效果。',
            });
          } catch (e: any) {
            sendJson(res, 400, { ok: false, error: e?.message || String(e) });
          }
        });
      });
    },
  };
}
