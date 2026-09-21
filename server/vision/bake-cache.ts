/**
 * 预渲染产物在磁盘上的盘点与清理。从 server/vite-plugin-vision.ts 逐字搬来。
 *
 * 只认键、不认路径,所以它碰不到素材目录以外的东西。键怎么算在 bake.ts 的 `bakeTarget`,
 * 这里只负责「目录里现在有哪些、各自多大」。
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { mediaDir } from "../vite-plugin-media";

/**
 * 磁盘上现有的烘焙文件。键就是文件名尾巴上那 12 位输入哈希(见 bakeTarget)。
 *
 * 预烘焙的调度要先知道「哪些已经有了、各自多大」才能排队和算占用 ——
 * 而这个答案只有服务端有:浏览器那边关一次页面就忘了,上次开着编辑器烘出来的文件
 * 它一个都不认识。
 */
export async function listBakes(root: string): Promise<{ key: string; name: string; bytes: number }[]> {
  const dir = mediaDir(root);
  let names: string[];
  try { names = await fsp.readdir(dir); } catch { return []; }
  const out: { key: string; name: string; bytes: number }[] = [];
  for (const name of names) {
    if (!/^bake-.*\.png$/.test(name)) continue;
    /*
     * 认不出键的也要收进来,**用文件名当键**。
     *
     * 键的格式换过(早先是 8 位哈希,现在 12 位),目录里现在就躺着 9 个老格式的文件。
     * 要是只认当前格式,这些文件**永远列不出来、也就永远删不掉** —— 一个只进不出的角落。
     * 收进来之后它们必然对不上任何一张卡,于是自动进 orphans,下一轮就被清掉。
     */
    const m = /^bake-.*-([0-9a-f]{12})\.png$/.exec(name);
    try { out.push({ key: m ? m[1] : name, name, bytes: (await fsp.stat(path.join(dir, name))).size }); } catch { /* 刚被删掉,跳过 */ }
  }
  return out;
}

/**
 * 删掉指定的烘焙文件。**只认键,不认路径。**
 *
 * 客户端传来的键要和服务端**自己列出来的目录**逐个比对,只有对得上的才删。
 * 所以传什么进来都跑不出 out/media,也碰不到烘焙以外的文件 ——
 * 安全性来自「拿列表比对」,不来自对字符串长什么样的猜测。
 */
export async function evictBakes(root: string, keys: unknown): Promise<{ deleted: string[]; freedBytes: number }> {
  const want = new Set((Array.isArray(keys) ? keys : []).filter((k): k is string => typeof k === "string" && k.length > 0));
  const deleted: string[] = [];
  let freedBytes = 0;
  if (!want.size) return { deleted, freedBytes };
  const dir = mediaDir(root);
  for (const f of await listBakes(root)) {
    if (!want.has(f.key)) continue;
    try { await fsp.unlink(path.join(dir, f.name)); deleted.push(f.key); freedBytes += f.bytes; } catch { /* 已经没了 */ }
  }
  return { deleted, freedBytes };
}
