/**
 * root 入口启动时自己核一遍：它要以 root 执行的这份代码，是不是只有 root 改得了。
 *
 * root 入口读配置和私钥时逐个核属主（`rootRead`），但代码不经那条路——而它是 `User=root` 加
 * `ExecStart=<node> <部署目录>/server/agent-service/account-root-main.mjs`。部署目录如果归别的用户（比如和渲染服务共用、
 * 归部署用的那个账号），那个用户改一个文件就等于拿到 root。所以：
 *   - 入口文件的路径上每一级目录，属主都得是 root、组和别人都写不了；路径上的符号链接（常见的 `current -> releases/<提交>`）
 *     属主得是 root，并且沿它指向的真实路径再核一遍；
 *   - 入口所在的整棵 `server/`（root 入口静态引用到的文件全在它里面）：每个目录、每个文件属主是 root、组和别人写不了，里面不许有符号链接；
 *   - node 可执行文件同样核它的路径。
 * 不满足就拒绝启动（`root-code-untrusted`，带上是哪一个路径），不带着一份别人改得了的代码以 root 跑。
 *
 * 纯检查，不改任何东西。看文件系统的三样（lstat、readlink、readdir）可以换成受控的，所以在哪台机器上都测得到。
 */
import fsp from 'node:fs/promises';
import path from 'node:path';

const untrusted = (file, why) => { throw Object.assign(new Error(`root-code-untrusted ${why} ${file}`), { code: 'root-code-untrusted', file, why }); };
const writableByOthers = stat => (Number(stat.mode) & 0o022) !== 0;

/**
 * @param {object} o
 * @param {string} o.entryFile root 入口文件的绝对路径（照启动时写的那样，不先解链接）
 * @param {string} [o.node] node 可执行文件的绝对路径
 * @param {{ lstat: Function, readlink: Function, readdir: Function }} [o.fs]
 * @returns {Promise<{ entry: string, codeRoot: string, node: string | null, checked: number }>} 解开链接以后的真实位置，和核过的条目数
 */
export async function assertRootOwnedCode({ entryFile, node = null, fs = fsp } = {}) {
  const posix = path.posix;
  if (typeof entryFile !== 'string' || !posix.isAbsolute(entryFile) || (node !== null && (typeof node !== 'string' || !posix.isAbsolute(node))))
    untrusted(String(entryFile), 'path');
  let checked = 0;
  /** 逐级核一条路径，回它解开链接以后的真实路径 */
  async function trustedPath(file, hops = 0) {
    if (hops > 16) untrusted(file, 'symlink-loop');
    const parts = posix.normalize(file).split('/').filter(Boolean);
    let current = '/';
    const top = await fs.lstat('/'); checked += 1;
    if (!top.isDirectory() || top.uid !== 0 || writableByOthers(top)) untrusted('/', 'directory');
    for (let i = 0; i < parts.length; i++) {
      const next = posix.join(current, parts[i]), stat = await fs.lstat(next); checked += 1;
      if (stat.isSymbolicLink()) {
        // 链接所在的目录上面已经核过（别人改不了它指向哪）；链接本身也得是 root 的。然后沿它指向的地方从头再核
        if (stat.uid !== 0) untrusted(next, 'symlink-owner');
        const target = posix.resolve(current, await fs.readlink(next));
        return trustedPath(posix.join(target, ...parts.slice(i + 1)), hops + 1);
      }
      const last = i === parts.length - 1;
      if (!last && !stat.isDirectory()) untrusted(next, 'directory');
      if (last && !stat.isFile() && !stat.isDirectory()) untrusted(next, 'file');
      if (stat.uid !== 0) untrusted(next, 'owner');
      if (writableByOthers(stat)) untrusted(next, 'writable');
      current = next;
    }
    return current;
  }
  async function trustedTree(dir) {
    for (const name of await fs.readdir(dir)) {
      const file = posix.join(dir, name), stat = await fs.lstat(file); checked += 1;
      if (stat.isSymbolicLink()) untrusted(file, 'symlink');
      if (!stat.isDirectory() && !stat.isFile()) untrusted(file, 'file');
      if (stat.uid !== 0) untrusted(file, 'owner');
      if (writableByOthers(stat)) untrusted(file, 'writable');
      if (stat.isDirectory()) await trustedTree(file);
    }
  }
  const entry = await trustedPath(entryFile);
  // <代码根>/server/agent-service/account-root-main.mjs：整棵 server/ 都核
  const codeRoot = posix.dirname(posix.dirname(entry));
  if (posix.basename(codeRoot) !== 'server' || posix.basename(posix.dirname(entry)) !== 'agent-service') untrusted(entry, 'layout');
  await trustedTree(codeRoot);
  const realNode = node === null ? null : await trustedPath(node);
  return { entry, codeRoot, node: realNode, checked };
}
