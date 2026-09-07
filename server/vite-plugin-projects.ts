import type { Plugin, ViteDevServer } from "vite";
import type { ServerResponse } from "node:http";
import fs from "node:fs";
import path from "node:path";

/**
 * 本地草稿:每份草稿就是磁盘上的一个 .proc 文件。
 *
 * 存在项目根的 `.pc-projects/` 下(和 `.pc-chats/` 一个路数,已在 .gitignore 里)。
 * 用真文件而不是 localStorage,是因为草稿要能被备份、拷走、和「保存项目」导出的
 * .proc 互换 —— 两边是同一个格式,导出的文件丢回这个目录就是一份草稿。
 */

const DIR = ".pc-projects";
const EXT = ".proc";

/** 草稿 id 只允许这些字符:直接当文件名用,不能让 ../ 之类跑出目录 */
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** 导出给测试用:这道校验是唯一挡住路径穿越的东西,值得单独钉住 */
export function isValidDraftId(id: string): boolean {
  return ID_RE.test(id);
}

function projectsDir(root: string): string {
  const dir = path.join(root, DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fileFor(root: string, id: string): string | null {
  if (!isValidDraftId(id)) return null;
  return path.join(projectsDir(root), id + EXT);
}

function sendJson(res: ServerResponse, code: number, data: unknown) {
  if (res.headersSent) return;
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(data));
}

function readBody(req: { on: (ev: string, fn: (c?: unknown) => void) => void; destroy: () => void }, limit = 64 * 1024 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
      // 编排文件再大也就几 MB;超了多半是把素材本身塞进来了
      if (body.length > limit) {
        req.destroy();
        reject(new Error("项目文件太大"));
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", () => reject(new Error("读取请求体失败")));
  });
}

/** 从 .proc 内容里挑出列表要显示的那几样,顺带兜住坏文件 */
function summarize(id: string, file: string) {
  const stat = fs.statSync(file);
  const base = { id, updatedAt: stat.mtime.toISOString(), size: stat.size };
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    const project = doc?.project ?? doc;
    // 项目可以有多条剪辑:激活那条在 tracks 里,其余停放在 cuts[].tracks 里,列表里的段数把它们都算上
    const countTracks = (tracks: unknown) =>
      (Array.isArray(tracks) ? (tracks as { clips?: unknown[] }[]) : []).reduce((n, t) => n + (t.clips?.length ?? 0), 0);
    const clips = countTracks(project?.tracks)
      + (Array.isArray(project?.cuts) ? (project.cuts as { tracks?: unknown }[]).reduce((n, c) => n + countTracks(c.tracks), 0) : 0);
    return {
      ...base,
      name: project?.name || id,
      duration: Number(project?.duration) || 0,
      clips,
      thumbnail: typeof doc?.thumbnail === "string" ? doc.thumbnail : null,
      broken: false,
    };
  } catch {
    // 坏文件也列出来,让用户看得见、删得掉,而不是凭空消失
    return { ...base, name: id, duration: 0, clips: 0, thumbnail: null, broken: true };
  }
}

export function projectsPlugin(): Plugin {
  return {
    name: "promptcut-projects",
    configureServer(server: ViteDevServer) {
      const root = server.config.root || process.cwd();

      server.middlewares.use("/api/projects", async (req, res) => {
        const url = new URL(req.url || "/", "http://localhost");
        // middlewares.use 会把挂载前缀吃掉,所以这里的 pathname 是 "/" 或 "/<id>"
        const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));

        try {
          if (req.method === "GET" && !id) {
            const dir = projectsDir(root);
            const items = fs
              .readdirSync(dir)
              .filter((f) => f.endsWith(EXT))
              .map((f) => summarize(f.slice(0, -EXT.length), path.join(dir, f)))
              // 最近改的排最前,和「本地草稿」的直觉一致
              .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            return sendJson(res, 200, { ok: true, projects: items });
          }

          const file = fileFor(root, id);
          if (!file) return sendJson(res, 400, { ok: false, error: "草稿 id 不合法" });

          if (req.method === "GET") {
            if (!fs.existsSync(file)) return sendJson(res, 404, { ok: false, error: "草稿不存在" });
            res.statusCode = 200;
            res.setHeader("Content-Type", "application/json; charset=utf-8");
            res.setHeader("Cache-Control", "no-store");
            return res.end(fs.readFileSync(file, "utf8"));
          }

          if (req.method === "PUT") {
            const body = await readBody(req as never);
            // 先解析一次:宁可这里报错,也不要把坏 JSON 写成草稿
            JSON.parse(body);
            fs.writeFileSync(file, body, "utf8");
            return sendJson(res, 200, { ok: true, ...summarize(id, file) });
          }

          if (req.method === "DELETE") {
            if (fs.existsSync(file)) fs.unlinkSync(file);
            return sendJson(res, 200, { ok: true });
          }

          return sendJson(res, 405, { ok: false, error: "只支持 GET / PUT / DELETE" });
        } catch (e) {
          return sendJson(res, 400, { ok: false, error: (e as Error).message });
        }
      });
    },
  };
}

export default projectsPlugin;
