/**
 * 托管组合的部署参数与远端脚本（SP，契约 `docs/plan/shared-project-contract.md` 第 2 节）。
 * `scripts/remote/docservice.mjs deploy-hosted` / `status-hosted` 用它；本模块没有副作用，单测直接 import（`server/**` 不许引 `scripts/`，所以放在这里；它随部署清单一起拷到远端，但入口不引它）。
 * 只引 Node 内置模块。
 */

/** 两个实例的参数（契约第 2 节）。部署目录与数据目录可由环境变量覆盖 */
export function hostedInstance(name = 'main', env = process.env) {
  if (name !== 'main' && name !== 'drill') throw new Error('--instance 只能是 drill（不给就是正式实例）');
  const drill = name === 'drill';
  return {
    name,
    app: drill ? 'promptcut-drill' : 'promptcut-hosted',
    docPort: drill ? 8777 : 8787,
    assetPort: drill ? 8778 : 8788,
    dir: env.PROMPTCUT_HOSTED_DIR || (drill ? '/opt/promptcut-drill' : '/opt/promptcut-hosted'),
    data: env.PROMPTCUT_HOSTED_DATA || (drill ? '/var/lib/promptcut/drill' : '/var/lib/promptcut/hosted'),
    maxMemory: drill ? '400M' : '700M',
  };
}

/**
 * 校验 `deploy-hosted` 的两个公网地址参数（C10a 契约第 3 节）：`--doc-public-url` 收 `ws(s)://` 或 `http(s)://`，
 * `--asset-public-url` 收 `http(s)://`。不给回 undefined；给了但不对抛错（写错的地址不悄悄换成缺省值）。
 */
export function checkPublicUrl(value, kind) {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  let u;
  try {
    u = new URL(text);
  } catch {
    throw new Error(`--${kind}-public-url 不是合法的地址：${text}`);
  }
  const ok = kind === 'doc' ? ['ws:', 'wss:', 'http:', 'https:'] : ['http:', 'https:'];
  if (!ok.includes(u.protocol)) throw new Error(`--${kind}-public-url 要以 ${ok.map((p) => `${p}//`).join(' / ')} 开头：${text}`);
  return text;
}

/**
 * PM2 配置（写在远端部署目录里，仓库外）：fork 模式、1 个实例；环境里没有任何秘密。
 *
 * 两个公网地址缺省按 `publicHost` 拼成 `ws://<主机>:<端口>`、`http://<主机>:<端口>/api/asset`；
 * `urls.docPublicUrl` / `urls.assetPublicUrl`（`--doc-public-url` / `--asset-public-url`，C10a 契约第 3 节）给了就用给的，
 * 阿里云上是 `wss://<域名>/hosted/`、`https://<域名>/media/api/asset`，重新部署不再被改回端口直连的地址。
 */
export function hostedPm2Config(inst, publicHost, urls = {}) {
  const env = {
    NODE_ENV: 'production',
    PROMPTCUT_DATA_DIR: inst.data,
    PROMPTCUT_DOCSERVICE_HOST: '0.0.0.0',
    PROMPTCUT_DOCSERVICE_PORT: String(inst.docPort),
    PROMPTCUT_ASSET_PORT: String(inst.assetPort),
    PROMPTCUT_DOCSERVICE_PUBLIC_URL: urls.docPublicUrl || `ws://${publicHost}:${inst.docPort}`,
    PROMPTCUT_ASSET_PUBLIC_URL: urls.assetPublicUrl || `http://${publicHost}:${inst.assetPort}/api/asset`,
  };
  const app = {
    name: inst.app,
    script: 'server/hosted/main.mjs',
    cwd: `${inst.dir}/app`,
    exec_mode: 'fork',
    instances: 1,
    max_memory_restart: inst.maxMemory,
    kill_timeout: 5000,
    time: true,
    env,
  };
  return '// 由 scripts/remote/docservice.mjs deploy-hosted 生成，不在仓库里。集群令牌不在这里：在 <数据目录>/secrets/cluster-token。\n'
    + `module.exports = { apps: [${JSON.stringify(app, null, 2)}] };\n`;
}

/** bash 单引号转义 */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * 在线构建（`--editor`，C10a 契约第 3 节）换上去的几行：本机已把 `dist-online/` 拷成 `<部署目录>/.incoming-editor`。
 * - 旧版的 `assets/` 保留一代：上一代自己的文件清单在 `editor/.assets-own` 里，逐个补进新版的 `assets/`（新版已有的不盖），
 *   正在用旧页面的人刷新前还取得到旧资源；再往前的几代不补，所以只留一代；
 * - 新版自己的清单写成新的 `.assets-own`（在补进旧文件之前记）；
 * - 整个目录换名换上去（先把旧的挪成 `editor.prev` 再删），nginx 不会读到拷了一半的目录。
 * nginx 的 `/editor` 路由由主会话在服务器上手工加（契约第 2 节），这里不碰。
 */
export function editorSwapLines() {
  return [
    '# 在线构建：.incoming-editor 换成 editor/，旧版 assets/ 保留一代',
    'if [ ! -f .incoming-editor/index.html ]; then echo ".incoming-editor 里没有 index.html" >&2; exit 4; fi',
    'mkdir -p .incoming-editor/assets',
    '( cd .incoming-editor/assets && find . -maxdepth 1 -type f -printf "%f\\n" | sort ) > .incoming-editor/.assets-own',
    'if [ -f editor/.assets-own ] && [ -d editor/assets ]; then',
    '  kept=0',
    '  while IFS= read -r f; do',
    '    [ -n "$f" ] || continue',
    '    if [ -f "editor/assets/$f" ] && [ ! -e ".incoming-editor/assets/$f" ]; then cp -p "editor/assets/$f" ".incoming-editor/assets/$f"; kept=$((kept + 1)); fi',
    '  done < editor/.assets-own',
    '  echo "editor: 保留上一代 assets $kept 个"',
    'fi',
    'rm -rf editor.prev',
    'if [ -d editor ]; then mv editor editor.prev; fi',
    'mv .incoming-editor editor',
    'rm -rf editor.prev',
    'echo "editor: $(wc -l < editor/.assets-own) 个本代 assets，$(find editor/assets -maxdepth 1 -type f | wc -l) 个在位"',
  ];
}

/**
 * 经 ssh 标准输入交给远端 bash 的部署脚本。令牌（只在 --write-token 时有）只出现在这段文本里，已校验只含 base64url 字符。
 * `editor: true`（`--editor`）时，本机已把在线构建拷到 `<部署目录>/.incoming-editor`，脚本把它换成 `editor/`（`editorSwapLines`）。
 */
export function hostedDeployScript(inst, { pm2Config, save, replaceDocservice, token, editor = false }) {
  const lines = [
    'set -euo pipefail',
    'set +x',
    `DIR=${shq(inst.dir)}`,
    `DATA=${shq(inst.data)}`,
    `APP=${shq(inst.app)}`,
    'cd "$DIR"',
    '# 新代码先落在 .incoming，整目录换上去，避免 PM2 重载时读到拷了一半的文件',
    'rm -rf app.prev',
    'if [ -d app ]; then mv app app.prev; fi',
    'mv .incoming app',
    'rm -rf app.prev',
    ...(editor ? editorSwapLines() : []),
    '# 数据目录与 secrets/：没有就建（0700）；已有的内容不动',
    'umask 077',
    'mkdir -p "$DATA/secrets"',
    'chmod 700 "$DATA" "$DATA/secrets"',
  ];
  if (token) {
    lines.push(
      `printf '%s\\n' ${shq(token)} > "$DATA/secrets/cluster-token.tmp"`,
      'mv "$DATA/secrets/cluster-token.tmp" "$DATA/secrets/cluster-token"',
      'echo "cluster-token: written"',
    );
  }
  lines.push(
    'if [ -f "$DATA/secrets/cluster-token" ]; then chmod 600 "$DATA/secrets/cluster-token"; echo "cluster-token: present (0600)"; else echo "cluster-token: absent (管理接口只认本机回环)"; fi',
    'umask 022',
    'cat > "$DIR/pm2.config.cjs" <<\'PM2CONFIG\'',
    pm2Config.replace(/\n$/, ''),
    'PM2CONFIG',
    '# 旧的独立文档服务占着同一个端口时：没说替换就停手',
    'if [ "$APP" = "promptcut-hosted" ] && pm2 describe promptcut-docservice >/dev/null 2>&1; then',
    replaceDocservice
      ? '  pm2 delete promptcut-docservice; echo "promptcut-docservice: deleted (它的部署目录与数据不动)"'
      : '  echo "promptcut-docservice 还在 PM2 里（占 8787）；确认要换成托管组合时加 --replace-docservice" >&2; exit 3',
    'fi',
    'pm2 startOrReload "$DIR/pm2.config.cjs" --update-env',
    save ? 'pm2 save' : 'echo "pm2 save: skipped (加 --save 才保存)"',
    'if ! systemctl is-enabled "pm2-$(id -un)" >/dev/null 2>&1; then',
    '  pm2 startup systemd -u "$(id -un)" --hp "$HOME" >/dev/null',
    '  echo "pm2 startup: installed pm2-$(id -un).service"',
    'fi',
    'echo "== healthz"',
    'ok=0',
    'for i in $(seq 1 30); do',
    `  if curl -fsS "http://127.0.0.1:${inst.docPort}/healthz" >/dev/null && curl -fsS "http://127.0.0.1:${inst.assetPort}/healthz"; then ok=1; echo; break; fi`,
    '  sleep 0.5',
    'done',
    'if [ "$ok" != 1 ]; then',
    '  echo "healthz did not respond" >&2',
    '  pm2 logs "$APP" --lines 40 --nostream >&2 || true',
    '  exit 1',
    'fi',
    'pm2 describe "$APP" | grep -E "status|restarts|memory" || true',
  );
  return `${lines.join('\n')}\n`;
}
