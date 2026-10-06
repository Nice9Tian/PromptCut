/**
 * 托管方渲染服务的部署参数、模板填充与远端脚本（契约 `docs/plan/hosted-render-contract.md` 第 7 节；HR22）。
 * `scripts/remote/docservice.mjs` 的 `install-render` / `deploy-render` / `status-render` / `stop-render` / `rollback-render` /
 * `keygen-render` 用它。本模块没有副作用（读模板文件除外），单测直接 import。只引 Node 内置模块。
 *
 * 布置（契约第 7.4 节）：
 *
 *   <部署目录>（缺省 /opt/promptcut-render）
 *     releases/<提交前 12 位>/   仓库在那个提交的完整内容（本机 git archive 打包上传，不含 .git）＋ node_modules ＋ Chrome
 *     current -> releases/<…>    PM2 的 cwd；升级与回退都是换这个链接
 *     .previous                  换链接之前 current 指的那一份（回退用）
 *     pm2.config.cjs             由模板 server/hosted/deploy/pm2-promptcut-render.config.cjs 填出来的，不含秘密
 *   /var/lib/promptcut/render/           工作进程的数据（可重建的缓存），属主 promptcut-render
 *   /var/lib/promptcut/render-secrets/   服务私钥，属主 root，0700
 *
 * 模板在 `server/hosted/deploy/`：`promptcut-render.slice`、`pm2-promptcut-render.config.cjs`，占位符写成 `{{名字}}`。
 * 填充只认 `renderTemplateValues` 给出的名字；模板里有认不得的占位符、或值里有不安全的字符，一律抛错（不静默留着）。
 * 生成的内容里没有令牌、私钥、密码：服务私钥只在 `<私钥目录>/service-key.json`，由 keygen 在节点上生成。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const RENDER_TEMPLATE_DIR = path.resolve(HERE, '..', 'hosted', 'deploy');
export const RENDER_SLICE_TEMPLATE = 'promptcut-render.slice';
export const RENDER_PM2_TEMPLATE = 'pm2-promptcut-render.config.cjs';

/** 装在节点上的系统包（契约第 7.4 节、Puppeteer 排障页列的 Chrome 运行库）。`libasound2` 在 Ubuntu 24.04 上叫 `libasound2t64`，脚本里判 */
export const RENDER_APT_PACKAGES = Object.freeze([
  'fonts-noto-cjk', 'fonts-noto-color-emoji', 'fonts-liberation', 'ffmpeg',
  'ca-certificates', 'libatk-bridge2.0-0', 'libatk1.0-0', 'libc6', 'libcairo2', 'libcups2', 'libdbus-1-3', 'libexpat1',
  'libfontconfig1', 'libgbm1', 'libgcc1', 'libglib2.0-0', 'libgtk-3-0', 'libnspr4', 'libnss3', 'libpango-1.0-0',
  'libpangocairo-1.0-0', 'libstdc++6', 'libx11-6', 'libx11-xcb1', 'libxcb1', 'libxcomposite1', 'libxcursor1', 'libxdamage1',
  'libxext6', 'libxfixes3', 'libxi6', 'libxrandr2', 'libxrender1', 'libxss1', 'libxtst6', 'lsb-release', 'wget', 'xdg-utils',
]);
/** `npm ci` 要编译原生模块时才装（`install-render --with-build-tools`） */
export const RENDER_BUILD_PACKAGES = Object.freeze(['build-essential', 'python3']);

/** 本机保留几份旧发布目录（含 current 与 .previous 指的那两份） */
export const RENDER_KEEP_RELEASES = 5;

/** bash 单引号转义 */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

const ABS_PATH = /^\/[A-Za-z0-9_./-]*$/;
const SIZE = /^[1-9]\d*[KMGT]?$/;
const USERNAME = /^[a-z_][a-z0-9_-]{0,31}$/;

class DeployUsageError extends Error {}
export { DeployUsageError };

const path$ = (name, value) => {
  if (typeof value !== 'string' || !ABS_PATH.test(value) || value.includes('..') || value.length > 200) throw new DeployUsageError(`${name} 要是绝对路径（只含字母、数字、_ . / -）：${value}`);
  return value.replace(/\/+$/, '') || '/';
};
const int$ = (name, value, min, max) => {
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new DeployUsageError(`${name} 要是 ${min}～${max} 的整数：${value}`);
  return n;
};
const size$ = (name, value) => {
  if (typeof value !== 'string' || !SIZE.test(value)) throw new DeployUsageError(`${name} 要像 6G、500M：${value}`);
  return value;
};

/**
 * 部署参数（契约第 7.2 节）；缺省值与服务的缺省一致，可用环境变量覆盖（部署脚本跑在本机，环境变量是本机的）：
 * `PROMPTCUT_RENDER_DIR`（部署目录）、`PROMPTCUT_RENDER_DATA`、`PROMPTCUT_RENDER_SECRETS`、`PROMPTCUT_HOSTED_DATA`（托管数据目录，keygen 写登记表用）、
 * `PROMPTCUT_RENDER_DOC_URL`、`PROMPTCUT_RENDER_PORT`、`PROMPTCUT_RENDER_STATUS_PORT`、`PROMPTCUT_RENDER_MAX_CONCURRENT`、`PROMPTCUT_RENDER_MAX_PROJECTS`、
 * `PROMPTCUT_RENDER_MEMORY_MAX` / `_MEMORY_HIGH`、`PROMPTCUT_RENDER_CPU_QUOTA`、`PROMPTCUT_RENDER_USER`（空串表示与管理进程同一用户）、
 * `PROMPTCUT_RENDER_USER_CARDS`、`PROMPTCUT_RENDER_EDITOR_DIR`。
 */
export function renderInstance(env = process.env) {
  const e = (name, fallback) => (env[name] === undefined ? fallback : env[name]);
  const userRaw = e('PROMPTCUT_RENDER_USER', 'promptcut-render');
  if (userRaw !== '' && !USERNAME.test(userRaw)) throw new DeployUsageError(`PROMPTCUT_RENDER_USER 要是系统用户名或空串：${userRaw}`);
  const userCards = e('PROMPTCUT_RENDER_USER_CARDS', 'isolated');
  if (userCards !== 'isolated' && userCards !== 'off') throw new DeployUsageError(`PROMPTCUT_RENDER_USER_CARDS 只能是 isolated 或 off：${userCards}`);
  const docUrl = e('PROMPTCUT_RENDER_DOC_URL', 'ws://127.0.0.1:8787');
  let u;
  try { u = new URL(docUrl); } catch { throw new DeployUsageError(`PROMPTCUT_RENDER_DOC_URL 不是合法的地址：${docUrl}`); }
  if (!['ws:', 'wss:'].includes(u.protocol) || /[\s'"\\${}`]/.test(docUrl)) throw new DeployUsageError(`PROMPTCUT_RENDER_DOC_URL 要是 ws:// 或 wss:// 开头的地址：${docUrl}`);
  const dir = path$('PROMPTCUT_RENDER_DIR', e('PROMPTCUT_RENDER_DIR', '/opt/promptcut-render'));
  return {
    app: 'promptcut-render',
    dir,
    releases: `${dir}/releases`,
    current: `${dir}/current`,
    data: path$('PROMPTCUT_RENDER_DATA', e('PROMPTCUT_RENDER_DATA', '/var/lib/promptcut/render')),
    secrets: path$('PROMPTCUT_RENDER_SECRETS', e('PROMPTCUT_RENDER_SECRETS', '/var/lib/promptcut/render-secrets')),
    hostedData: path$('PROMPTCUT_HOSTED_DATA', e('PROMPTCUT_HOSTED_DATA', '/var/lib/promptcut/hosted')),
    editorDir: path$('PROMPTCUT_RENDER_EDITOR_DIR', e('PROMPTCUT_RENDER_EDITOR_DIR', '/opt/promptcut-hosted/editor')),
    docUrl,
    workerPort: int$('PROMPTCUT_RENDER_PORT', e('PROMPTCUT_RENDER_PORT', 5400), 1024, 65000),
    statusPort: int$('PROMPTCUT_RENDER_STATUS_PORT', e('PROMPTCUT_RENDER_STATUS_PORT', 5399), 1024, 65535),
    maxConcurrent: int$('PROMPTCUT_RENDER_MAX_CONCURRENT', e('PROMPTCUT_RENDER_MAX_CONCURRENT', 2), 1, 4),
    maxProjects: int$('PROMPTCUT_RENDER_MAX_PROJECTS', e('PROMPTCUT_RENDER_MAX_PROJECTS', 16), 1, 1000),
    memoryMax: size$('PROMPTCUT_RENDER_MEMORY_MAX', e('PROMPTCUT_RENDER_MEMORY_MAX', '6G')),
    memoryHigh: size$('PROMPTCUT_RENDER_MEMORY_HIGH', e('PROMPTCUT_RENDER_MEMORY_HIGH', '5G')),
    cpuQuota: (() => {
      const v = e('PROMPTCUT_RENDER_CPU_QUOTA', '400%');
      if (!/^[1-9]\d{1,4}%$/.test(v)) throw new DeployUsageError(`PROMPTCUT_RENDER_CPU_QUOTA 要像 400%：${v}`);
      return v;
    })(),
    maxMemoryRestart: '300M',
    killTimeoutMs: 20_000,
    user: userRaw,
    userCards,
    slice: 'promptcut-render.slice',
  };
}

/** 模板里所有占位符的取值（都已在 `renderInstance` 里校验过，字符集里没有引号、反斜杠、`$`、反引号、花括号） */
export function renderTemplateValues(inst) {
  return {
    DIR: inst.dir,
    DATA: inst.data,
    SECRETS: inst.secrets,
    EDITOR_DIR: inst.editorDir,
    DOC_URL: inst.docUrl,
    WORKER_PORT: String(inst.workerPort),
    STATUS_PORT: String(inst.statusPort),
    MAX_CONCURRENT: String(inst.maxConcurrent),
    MAX_PROJECTS: String(inst.maxProjects),
    MEMORY_MAX: inst.memoryMax,
    MEMORY_HIGH: inst.memoryHigh,
    CPU_QUOTA: inst.cpuQuota,
    RENDER_USER: inst.user,
    USER_CARDS: inst.userCards,
    MAX_MEMORY_RESTART: inst.maxMemoryRestart,
    KILL_TIMEOUT_MS: String(inst.killTimeoutMs),
  };
}

/** 填模板：每个 `{{名字}}` 换成 `values[名字]`；认不得的占位符抛错；填完不许再剩 `{{` */
export function fillTemplate(text, values) {
  const out = String(text).replace(/\{\{([A-Z_]+)\}\}/g, (m, name) => {
    if (!Object.hasOwn(values, name)) throw new DeployUsageError(`模板里有认不得的占位符 ${m}`);
    return values[name];
  });
  if (out.includes('{{') || out.includes('}}')) throw new DeployUsageError('模板填完还剩 {{ 或 }}');
  return out;
}

export function readTemplate(name, dir = RENDER_TEMPLATE_DIR) {
  return fs.readFileSync(path.join(dir, name), 'utf8').replace(/\r\n/g, '\n');
}

/** PM2 配置（写进 `<部署目录>/pm2.config.cjs`；不含任何秘密） */
export function renderPm2Config(inst, { read = readTemplate } = {}) {
  return fillTemplate(read(RENDER_PM2_TEMPLATE), renderTemplateValues(inst));
}

/** systemd slice 单元（写进 `/etc/systemd/system/promptcut-render.slice`） */
export function renderSliceUnit(inst, { read = readTemplate } = {}) {
  return fillTemplate(read(RENDER_SLICE_TEMPLATE), renderTemplateValues(inst));
}

/** 发布目录名：提交的前 12 位十六进制 */
export function releaseIdOf(commit) {
  const c = String(commit ?? '').trim().toLowerCase();
  if (!/^[0-9a-f]{12,64}$/.test(c)) throw new DeployUsageError(`提交号要是十六进制（至少 12 位）：${commit}`);
  return c.slice(0, 12);
}

const checkId = (id) => {
  if (!/^[0-9a-f]{12}$/.test(String(id))) throw new DeployUsageError(`发布目录名要是 12 位十六进制：${id}`);
  return id;
};

/** 每条脚本共同的开头 */
const preamble = (extra = []) => ['set -euo pipefail', 'set +x', ...extra];

/** 记在远端、人能看懂的「没有 systemd 时怎么办」 */
export const NO_SYSTEMD_NOTE = '没有 systemd：不建 slice；渲染服务的管理进程自检会报 no-cgroup（无 cgroup 上限，只靠进程内看护）并照常工作，也不装 PM2 的开机自启单元（见 README「没有 systemd 时」）';

/**
 * `install-render`：系统包、系统用户与目录、slice 单元。可以反复跑（已有的不动）。
 * 没有 systemd（容器）时跳过 slice 与 daemon-reload，打一行说明，不当错误。
 */
export function renderInstallScript(inst, { withBuildTools = false, read } = {}) {
  const pkgs = [...RENDER_APT_PACKAGES, ...(withBuildTools ? RENDER_BUILD_PACKAGES : [])];
  const slice = renderSliceUnit(inst, { read });
  const lines = preamble([
    'export DEBIAN_FRONTEND=noninteractive',
    `DIR=${shq(inst.dir)}`,
    `DATA=${shq(inst.data)}`,
    `SECRETS=${shq(inst.secrets)}`,
    `RUSER=${shq(inst.user)}`,
  ]);
  lines.push(
    'echo "== 系统包"',
    'apt-get update -qq',
    // Ubuntu 22.04 的 libasound2；24.04 起改名 libasound2t64
    'ASOUND=libasound2; if ! apt-cache show libasound2 >/dev/null 2>&1 && apt-cache show libasound2t64 >/dev/null 2>&1; then ASOUND=libasound2t64; fi',
    `apt-get install -y -qq --no-install-recommends "$ASOUND" ${pkgs.map(shq).join(' ')}`,
    'fc-cache -f >/dev/null 2>&1 || true',
    // 不用 grep -q：pipefail 下它提前退出会让 fc-list 吃 SIGPIPE，把「有」判成「没有」
    'if fc-list | grep -i "noto sans cjk" >/dev/null; then echo "中文字体：有 Noto Sans CJK"; else echo "中文字体：没找到 Noto Sans CJK（fonts-noto-cjk 没装上？）" >&2; exit 6; fi',
    'echo "ffmpeg: $(ffmpeg -version | head -n1)"',
    'echo "== 用户与目录"',
    'if [ -n "$RUSER" ]; then',
    '  if ! id -u "$RUSER" >/dev/null 2>&1; then',
    '    useradd --system --no-create-home --home-dir "$DATA" --shell /usr/sbin/nologin "$RUSER"',
    '    echo "用户 $RUSER：已建（无登录权限）"',
    '  else',
    '    echo "用户 $RUSER：已有"',
    '  fi',
    'fi',
    'install -d -m 0755 "$DIR" "$DIR/releases"',
    'if [ -n "$RUSER" ]; then install -d -o "$RUSER" -g "$RUSER" -m 0750 "$DATA"; else install -d -m 0750 "$DATA"; fi',
    // 私钥目录属主 root、0700；工作进程读不到
    'install -d -o root -g root -m 0700 "$SECRETS"',
    'echo "目录：$DIR（0755，releases/ 在里面）、$DATA（工作进程的数据）、$SECRETS（私钥，root 0700）"',
    'echo "== 资源组（systemd slice）"',
    'if [ -d /run/systemd/system ]; then',
    `  cat > /etc/systemd/system/${inst.slice} <<'PCRENDERSLICE'`,
    slice.replace(/\n$/, ''),
    'PCRENDERSLICE',
    '  systemctl daemon-reload',
    '  if [ "$(stat -fc %T /sys/fs/cgroup 2>/dev/null || true)" = cgroup2fs ]; then echo "cgroup v2：是"; else echo "cgroup v2：不是（slice 的 IOWeight 等可能不生效，渲染服务自检会报 no-cgroup 或照 cgroup v1 处理）" >&2; fi',
    `  echo "${inst.slice}：已写入 /etc/systemd/system 并 daemon-reload"`,
    'else',
    `  echo ${shq(NO_SYSTEMD_NOTE)}`,
    'fi',
    'echo "install-render：完成"',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * `deploy-render`（契约第 7.4 节）：本机已把提交打成 `<部署目录>/.incoming-<id>.tar.gz` 传上来。
 * 解到 `releases/<id>/`、`npm ci`、装 Chrome（都只在这个发布目录没装好时做）→ 写新的 PM2 配置 → 用它跑 `--check`
 * → 过了才换 `current`、`pm2 startOrReload`、（可选）`pm2 save` → 等诊断口回应。自检不过（退出码 78）什么都不换，旧的照常跑。
 * `noStart`：只解包装依赖、换 `current`、写配置，不跑也不卡自检、不动 PM2（第一次部署：先这样、再 keygen、再正式部署）。
 */
export function renderDeployScript(inst, { id, save = false, noStart = false, keep = RENDER_KEEP_RELEASES, read } = {}) {
  checkId(id);
  const config = renderPm2Config(inst, { read });
  const lines = preamble([
    `DIR=${shq(inst.dir)}`,
    `ID=${shq(id)}`,
    `APP=${shq(inst.app)}`,
    `STATUS_PORT=${inst.statusPort}`,
    `KEEP=${int$('keep', keep, 2, 50)}`,
    'REL="$DIR/releases/$ID"',
    'cd "$DIR"',
    'umask 022',
  ]);
  lines.push(
    '# 1. 解包、装依赖与 Chrome（这个发布目录没装好才做；装到一半的删掉重来）',
    'if [ -d "$REL" ] && [ ! -f "$REL/.extracted-ok" ]; then rm -rf "$REL"; fi',
    'if [ ! -d "$REL" ]; then',
    '  if [ ! -f ".incoming-$ID.tar.gz" ]; then echo "没有 $DIR/.incoming-$ID.tar.gz（本机没传上来？）" >&2; exit 4; fi',
    '  mkdir -p "$REL"',
    '  tar -xzf ".incoming-$ID.tar.gz" -C "$REL"',
    '  ( cd "$REL" && npm ci --no-audit --no-fund && PUPPETEER_CACHE_DIR="$REL/.cache/puppeteer" npx puppeteer browsers install chrome-headless-shell )',
    '  touch "$REL/.extracted-ok"',
    '  echo "release $ID：已解包、npm ci、装好 chrome-headless-shell"',
    'else',
    '  echo "release $ID：已在位，不重装"',
    'fi',
    'rm -f ".incoming-$ID.tar.gz"',
    '# 2. 新的 PM2 配置先写成 .new，自检用它的环境',
    'cat > "$DIR/pm2.config.cjs.new" <<\'PCRENDERPM2\'',
    config.replace(/\n$/, ''),
    'PCRENDERPM2',
  );
  if (noStart) {
    lines.push('echo "== 自检（--no-start：只看结果，不挡）"');
  } else {
    lines.push('echo "== 自检"');
  }
  // 用配置里的环境跑 `--check`，Chrome 用这个发布目录里的那份（还没换 current）
  const check = [
    'node -e \'const c=require(process.argv[1]).apps[0]; const {spawnSync}=require("node:child_process");',
    'const r=spawnSync(process.execPath,["server/hosted-render/main.mjs","--check"],{cwd:process.argv[2],stdio:"inherit",env:{...process.env,...c.env,PUPPETEER_CACHE_DIR:process.argv[2]+"/.cache/puppeteer"}});',
    'process.exit(r.status??1)\' "$DIR/pm2.config.cjs.new" "$REL"',
  ].join(' ');
  if (noStart) {
    lines.push(`${check} || echo "自检没过（第一次部署缺私钥是正常的：先 keygen-render 再不带 --no-start 重新部署）"`);
  } else {
    lines.push(
      `if ! ${check}; then`,
      '  echo "自检没过：current 与 PM2 都没动，旧的照常跑。看上面的 selfcheck.error 行" >&2',
      '  rm -f "$DIR/pm2.config.cjs.new"',
      '  exit 78',
      'fi',
    );
  }
  lines.push(
    '# 3. 换 current（先记下旧的，回退用）；配置换上去',
    'PREV=$(readlink -f "$DIR/current" 2>/dev/null || true)',
    'if [ -n "$PREV" ] && [ "$PREV" != "$REL" ] && [ -d "$PREV" ]; then basename "$PREV" > "$DIR/.previous"; fi',
    'ln -sfn "$REL" "$DIR/current.new"',
    'mv -T "$DIR/current.new" "$DIR/current"',
    'mv -f "$DIR/pm2.config.cjs.new" "$DIR/pm2.config.cjs"',
    'echo "current -> releases/$ID（上一份：$(cat "$DIR/.previous" 2>/dev/null || echo 无)）"',
  );
  if (noStart) {
    lines.push(
      'echo "--no-start：没动 PM2。接下来 keygen-render，再不带 --no-start 部署一次"',
    );
  } else {
    lines.push(
      '# 4. 起或重载（重载时管理进程先放回手里的认领、结束进程树）',
      'pm2 startOrReload "$DIR/pm2.config.cjs" --update-env',
      save ? 'pm2 save' : 'echo "pm2 save: skipped（加 --save 才保存；节点重启后靠它自动起来）"',
      // 没有 systemd 的机器不装开机自启（pm2 startup systemd 会失败）
      'if [ -d /run/systemd/system ]; then',
      '  if ! systemctl is-enabled "pm2-$(id -un)" >/dev/null 2>&1; then',
      '    pm2 startup systemd -u "$(id -un)" --hp "$HOME" >/dev/null',
      '    echo "pm2 startup: installed pm2-$(id -un).service"',
      '  fi',
      'else',
      `  echo ${shq(NO_SYSTEMD_NOTE)}`,
      'fi',
      '# 5. 等诊断口回应',
      'echo "== status"',
      'ok=0',
      'for i in $(seq 1 60); do',
      '  if curl -fsS "http://127.0.0.1:$STATUS_PORT/status" -o /tmp/promptcut-render-status.json 2>/dev/null; then ok=1; break; fi',
      '  sleep 1',
      'done',
      'if [ "$ok" != 1 ]; then',
      '  echo "诊断口 $STATUS_PORT 60 秒内没回应；回退：node scripts/remote/docservice.mjs rollback-render" >&2',
      '  pm2 logs "$APP" --lines 40 --nostream >&2 || true',
      '  exit 1',
      'fi',
      'node -e \'const s=JSON.parse(require("fs").readFileSync("/tmp/promptcut-render-status.json","utf8")); console.log(JSON.stringify({ codeVersion: s.codeVersion ?? null, selfcheck: s.selfcheck ?? null }))\' || true',
      'rm -f /tmp/promptcut-render-status.json',
      'pm2 describe "$APP" | grep -E "status|restarts|memory" || true',
    );
  }
  lines.push(
    '# 6. 旧发布目录只留最近 $KEEP 份（current 与 .previous 指的两份不删）',
    'PREVNAME=$(cat "$DIR/.previous" 2>/dev/null || true)',
    'ls -1dt "$DIR"/releases/*/ 2>/dev/null | tail -n +$((KEEP + 1)) | while IFS= read -r d; do',
    '  n=$(basename "$d")',
    '  if [ "$n" != "$ID" ] && [ "$n" != "$PREVNAME" ]; then rm -rf "$d"; echo "release $n：已清理"; fi',
    'done || true',
    'echo "deploy-render：完成"',
  );
  return `${lines.join('\n')}\n`;
}

/** `rollback-render`：把 current 换回上一份（或 `to` 指的那份）再重载。上一份必须还在 releases/ 里、装好了 */
export function renderRollbackScript(inst, { to = null } = {}) {
  if (to !== null) checkId(to);
  const lines = preamble([
    `DIR=${shq(inst.dir)}`,
    `APP=${shq(inst.app)}`,
    `STATUS_PORT=${inst.statusPort}`,
    `TO=${shq(to ?? '')}`,
    'cd "$DIR"',
  ]);
  lines.push(
    'CURRENT=$(basename "$(readlink -f "$DIR/current" 2>/dev/null || true)")',
    'if [ -z "$TO" ]; then TO=$(cat "$DIR/.previous" 2>/dev/null || true); fi',
    'if [ -z "$TO" ]; then echo "没有上一份可回退（.previous 是空的；用 --to <发布目录名> 指定）" >&2; exit 4; fi',
    'if [ ! -f "$DIR/releases/$TO/.extracted-ok" ]; then echo "releases/$TO 不在或没装好；现有：$(ls -1 "$DIR/releases" | tr "\\n" " ")" >&2; exit 4; fi',
    'if [ "$TO" = "$CURRENT" ]; then echo "current 已经是 $TO，没有要回退的"; exit 0; fi',
    'echo "$CURRENT" > "$DIR/.previous"',
    'ln -sfn "$DIR/releases/$TO" "$DIR/current.new"',
    'mv -T "$DIR/current.new" "$DIR/current"',
    'echo "current -> releases/$TO（原来是 $CURRENT）"',
    'pm2 startOrReload "$DIR/pm2.config.cjs" --update-env',
    'ok=0',
    'for i in $(seq 1 60); do',
    '  if curl -fsS "http://127.0.0.1:$STATUS_PORT/status" >/dev/null 2>&1; then ok=1; break; fi',
    '  sleep 1',
    'done',
    'if [ "$ok" != 1 ]; then echo "诊断口 $STATUS_PORT 60 秒内没回应" >&2; pm2 logs "$APP" --lines 40 --nostream >&2 || true; exit 1; fi',
    'pm2 describe "$APP" | grep -E "status|restarts" || true',
    'echo "rollback-render：完成"',
  );
  return `${lines.join('\n')}\n`;
}

/** `stop-render`：停掉渲染服务（`remove`：连 PM2 的登记一起删）。托管服务（promptcut-hosted）不动 */
export function renderStopScript(inst, { remove = false } = {}) {
  return `${preamble([`APP=${shq(inst.app)}`]).concat([
    'if ! pm2 describe "$APP" >/dev/null 2>&1; then echo "$APP 不在 PM2 里"; exit 0; fi',
    remove ? 'pm2 delete "$APP"; echo "$APP：已从 PM2 删除"' : 'pm2 stop "$APP"; echo "$APP：已停（PM2 里还在，pm2 start $APP 或 deploy-render 可起）"',
    // 存档里记停止的状态，节点重启后不会自己又起来；要起来就重新部署或 pm2 start 再 save
    'pm2 save >/dev/null && echo "pm2 save：已保存（节点重启后保持这个状态）"',
  ]).join('\n')}\n`;
}

/** `status-render`：PM2、诊断口、代码版本并排（不同标红）、资源组、产物容量记账 */
export function renderStatusScript(inst) {
  const lines = preamble([
    `DIR=${shq(inst.dir)}`,
    `APP=${shq(inst.app)}`,
    `STATUS_PORT=${inst.statusPort}`,
    `HOSTED_DATA=${shq(inst.hostedData)}`,
    `SLICE=${shq(inst.slice)}`,
  ]);
  lines.push(
    'echo "== pm2"',
    'pm2 describe "$APP" 2>/dev/null | grep -E "status|restarts|uptime|memory|script path|exec cwd" || echo "$APP: not in pm2"',
    'echo "== 发布目录"',
    'echo "current  -> $(readlink "$DIR/current" 2>/dev/null || echo 无)"',
    'echo "previous -> $(cat "$DIR/.previous" 2>/dev/null || echo 无)"',
    'echo "releases: $(ls -1 "$DIR/releases" 2>/dev/null | tr "\\n" " ")"',
    'echo "== 诊断口 /status"',
    'if curl -fsS "http://127.0.0.1:$STATUS_PORT/status" -o /tmp/promptcut-render-status.json 2>/dev/null; then',
    // 代码版本：渲染服务、在线页面、Agent 服务并排；不一致标红（一个任务也认领不了，却不报错，所以不能静默）
    '  node -e \'const s=JSON.parse(require("fs").readFileSync("/tmp/promptcut-render-status.json","utf8"));',
    '  const v=s.codeVersion; const red=(t)=>"\\x1b[31m"+t+"\\x1b[0m";',
    '  if(v){ const line="代码版本  render="+v.self+"  在线页面="+(v.editor??"?")+"  agent="+(v.agent??"（没配）"); console.log(v.match===false?red("!! "+line+"  不一致：认领不到任务，重新部署同一个提交"):line); } else console.log("代码版本：诊断口没给 codeVersion");',
    '  for (const k of ["selfcheck","directory","backpressure","resources","projects"]) if (s[k]!==undefined) console.log(k+": "+JSON.stringify(s[k]).slice(0,600));\'',
    '  rm -f /tmp/promptcut-render-status.json',
    'else',
    '  echo "诊断口 $STATUS_PORT 没回应（服务没起，或自检没过停着了：pm2 logs $APP --lines 40 --nostream）"',
    'fi',
    'echo "== 资源组"',
    'if [ -d /run/systemd/system ]; then',
    '  systemctl show "$SLICE" -p MemoryMax -p MemoryHigh -p CPUQuotaPerSecUSec -p TasksMax 2>/dev/null || echo "$SLICE 没有（install-render 没跑？）"',
    'else',
    `  echo ${shq(NO_SYSTEMD_NOTE)}`,
    'fi',
    'echo "== 产物容量记账（渲染服务写成的块）"',
    'U="$HOSTED_DATA/assets/.service-usage/render.ndjson"',
    'if [ -f "$U" ]; then echo "$U：$(wc -l < "$U") 行，$(du -h "$U" | cut -f1)"; else echo "还没有记账文件（渲染服务还没写过产物）"; fi',
    'df -h "$HOSTED_DATA" 2>/dev/null | tail -n1 || true',
  );
  return `${lines.join('\n')}\n`;
}

/**
 * `keygen-render`：在节点上跑 keygen（私钥在节点上生成、不离开节点、不打印）。
 * 默认生成并登记；`retire` 撤一把公钥；`list` 看登记表。从 `current`（或 `release` 指定的发布目录）里跑。
 */
export function renderKeygenScript(inst, { retire = null, list = false, instanceName = null, release = null } = {}) {
  if (retire !== null && !/^[A-Za-z0-9_-]{8}$/.test(retire)) throw new DeployUsageError(`--retire 要是 8 个字符的 kid：${retire}`);
  if (instanceName !== null && !/^[^\s'"\\${}`][^'"\\${}`]{0,63}$/.test(instanceName)) throw new DeployUsageError('--instance-name 要是 1～64 个字符，不含引号、反斜杠、$、花括号');
  if (release !== null) checkId(release);
  const base = release ? `${inst.releases}/${release}` : inst.current;
  const args = retire !== null
    ? `--hosted-data ${shq(inst.hostedData)} --retire ${shq(retire)}`
    : list
      ? `--hosted-data ${shq(inst.hostedData)} --list`
      : `--hosted-data ${shq(inst.hostedData)} --secrets ${shq(inst.secrets)}${instanceName ? ` --instance-name ${shq(instanceName)}` : ''}`;
  const lines = preamble([`cd ${shq(base)}`]);
  lines.push(
    'if [ ! -f server/hosted-render/keygen.mjs ]; then echo "这个目录里没有 keygen（先 deploy-render --no-start）" >&2; exit 4; fi',
    'umask 077',
    `node server/hosted-render/keygen.mjs ${args}`,
  );
  if (retire === null && !list) {
    lines.push(
      `echo "新的公钥已登记进 ${inst.hostedData}/secrets/services.json（文档服务按文件修改时刻重读，不用重启）。"`,
      'echo "渲染服务要重启才用新私钥：pm2 restart promptcut-render（换钥时旧公钥并存，确认新钥生效后 keygen-render --retire <旧 kid>）"',
    );
  }
  return `${lines.join('\n')}\n`;
}

/**
 * 子命令的计划：参数解析与校验放在这里，`scripts/remote/docservice.mjs` 只负责执行（干跑与单测都走这里）。
 * @param {string} cmd  install-render | deploy-render | status-render | stop-render | rollback-render | keygen-render
 * @param {string[]} argv  命令名之后的参数
 * @param {NodeJS.ProcessEnv} env
 * @param {{ resolveCommit?: (ref: string) => string, read?: Function }} [deps]  `resolveCommit`：本机把 `--commit` 的引用解析成提交号（缺省不解析，只认十六进制）
 */
export function planRenderCommand(cmd, argv, env = process.env, deps = {}) {
  const inst = renderInstance(env);
  const flags = new Set();
  const opts = {};
  const valued = new Set(['--commit', '--to', '--retire', '--instance-name', '--release', '--keep']);
  const boolean = new Set(['--save', '--no-start', '--with-build-tools', '--delete', '--list', '--dry-run']);
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (valued.has(a)) {
      const v = argv[i += 1];
      if (v === undefined || v.startsWith('--')) throw new DeployUsageError(`${a} 要跟一个值`);
      opts[a] = v;
    } else if (boolean.has(a)) flags.add(a);
    else throw new DeployUsageError(`不认识的参数 ${a}`);
  }
  const allow = {
    'install-render': ['--with-build-tools', '--dry-run'],
    'deploy-render': ['--commit', '--save', '--no-start', '--keep', '--dry-run'],
    'status-render': ['--dry-run'],
    'stop-render': ['--delete', '--dry-run'],
    'rollback-render': ['--to', '--dry-run'],
    'keygen-render': ['--retire', '--list', '--instance-name', '--release', '--dry-run'],
  }[cmd];
  if (!allow) throw new DeployUsageError(`不认识的命令 ${cmd}`);
  for (const a of [...flags, ...Object.keys(opts)]) if (!allow.includes(a)) throw new DeployUsageError(`${cmd} 不收 ${a}`);
  const common = { cmd, inst, dryRun: flags.has('--dry-run') };
  switch (cmd) {
    case 'install-render':
      return { ...common, script: renderInstallScript(inst, { withBuildTools: flags.has('--with-build-tools'), read: deps.read }) };
    case 'deploy-render': {
      const ref = opts['--commit'] ?? 'HEAD';
      const commit = deps.resolveCommit ? deps.resolveCommit(ref) : ref;
      const id = releaseIdOf(commit);
      const keep = opts['--keep'] === undefined ? RENDER_KEEP_RELEASES : int$('--keep', opts['--keep'], 2, 50);
      return {
        ...common, commit, id, ref,
        upload: { archive: `.incoming-${id}.tar.gz`, remote: `${inst.dir}/.incoming-${id}.tar.gz` },
        script: renderDeployScript(inst, { id, save: flags.has('--save'), noStart: flags.has('--no-start'), keep, read: deps.read }),
      };
    }
    case 'status-render':
      return { ...common, script: renderStatusScript(inst) };
    case 'stop-render':
      return { ...common, script: renderStopScript(inst, { remove: flags.has('--delete') }) };
    case 'rollback-render':
      return { ...common, script: renderRollbackScript(inst, { to: opts['--to'] ?? null }) };
    case 'keygen-render':
      return {
        ...common,
        script: renderKeygenScript(inst, { retire: opts['--retire'] ?? null, list: flags.has('--list'), instanceName: opts['--instance-name'] ?? null, release: opts['--release'] ?? null }),
      };
    default:
      throw new DeployUsageError(`不认识的命令 ${cmd}`);
  }
}

export const RENDER_COMMANDS = Object.freeze(['install-render', 'deploy-render', 'status-render', 'stop-render', 'rollback-render', 'keygen-render']);
