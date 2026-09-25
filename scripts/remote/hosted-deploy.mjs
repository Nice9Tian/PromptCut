/**
 * 托管组合的部署参数与远端脚本（SP，契约 `docs/plan/shared-project-contract.md` 第 2 节）。
 * `scripts/remote/docservice.mjs deploy-hosted` / `status-hosted` 用它；本模块没有副作用，单测直接 import。
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

/** PM2 配置（写在远端部署目录里，仓库外）：fork 模式、1 个实例；环境里没有任何秘密 */
export function hostedPm2Config(inst, publicHost) {
  const env = {
    NODE_ENV: 'production',
    PROMPTCUT_DATA_DIR: inst.data,
    PROMPTCUT_DOCSERVICE_HOST: '0.0.0.0',
    PROMPTCUT_DOCSERVICE_PORT: String(inst.docPort),
    PROMPTCUT_ASSET_PORT: String(inst.assetPort),
    PROMPTCUT_DOCSERVICE_PUBLIC_URL: `ws://${publicHost}:${inst.docPort}`,
    PROMPTCUT_ASSET_PUBLIC_URL: `http://${publicHost}:${inst.assetPort}/api/asset`,
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

/** 经 ssh 标准输入交给远端 bash 的部署脚本。令牌（只在 --write-token 时有）只出现在这段文本里，已校验只含 base64url 字符 */
export function hostedDeployScript(inst, { pm2Config, save, replaceDocservice, token }) {
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
