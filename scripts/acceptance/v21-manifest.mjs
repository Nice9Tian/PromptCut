/**
 * 0.7.21 新进来的验收项（照 `v19-manifest.mjs` 的写法，字段含义见 `four-stage-manifest.mjs` 文件头）。
 *
 * 这一版合入的分支各自带了新探针，`--check-coverage` 的第 ① 类要求每支探针要么登记成清单项、
 * 要么写明排除原因。本文件登记三支：
 *
 *   V21-update-notice   在线编辑器的新版本提示（`gemini/editor-update-notice`）
 *   V21-direct-address  项目直达地址与分享链接（`claude/editor-deeplink`）
 *   V21-cut-online-br   在线浏览器替剪辑段里的重卡产流（〔裁〕R02，`claude/cut-stream` 留下的那一支；
 *                       同一轮的 R01 已被用户推翻、它的探针随返工删掉）
 *
 * 端口：这三支探针各自限定了自己的端口段（`update-notice-probe` 只认 6410～6419，
 * `account-direct-address-probe` 的夹具缺省 6430 起，`cut-online-browser-probe` 缺省 5910 起），
 * 所以这里按它们自己的段给，不用整套清单的 5690～5699。
 */
import '../lib/no-user-dirs.mjs';

const node = 'node';
const probe = (name, args = []) => [node, `scripts/probes/${name}.mjs`, ...args];
const ACCOUNT_ENV = ['PROMPTCUT_ACCOUNT_PROVIDER_ROOT', 'PROMPTCUT_PASSWORD_ORDER_MODULE'];

/** 0.7.21 的一支探针 */
function PR21(id, name, script, args, o = {}) {
  const { where = 'local', known, timeoutMin = 30, account = false, needs, prereq, covers } = o;
  return {
    id, name, category: 'V21', level: 'local', taskRef: o.taskRef || '0.7.21 发版（docs/plan/release-021-kickoff.md）',
    where, tasks: [], cmd: probe(script, args), requires: [`scripts/probes/${script}.mjs`],
    covers: covers || [`${script}.mjs`],
    ...(account ? { requiresEnv: ACCOUNT_ENV } : {}), ...(known ? { known } : {}),
    ...(needs ? { needs } : {}), ...(prereq ? { prereq } : {}),
    pass: { exit: 0 }, timeoutMin,
  };
}

export const V21_ITEMS = [
  PR21('V21-update-notice', '在线编辑器的新版本提示（U0～U6：启动不取、切回前台取一次、换了版本挂提示条、换回去撤下、点刷新真重载、舞台与导出页不提示、手机上一行放得下）',
    'update-notice-probe', ['--dist', '{dist}', '--port', '6410'],
    { needs: ['online-build'], timeoutMin: 25, known: '探针自己限定端口 6410～6419（被占就直接报错退出，不结束外部进程）' }),
  PR21('V21-direct-address', '项目直达地址与分享链接（8 条：新建后地址、刷新、回首页、分享链接加入、再开直达、非成员提示、旧链接、二级密码、手机版）',
    'account-direct-address-probe', ['--dist', '{dist}', '--out', '{item}'],
    { needs: ['online-build'], account: true, timeoutMin: 40, known: '要账号后端的两个环境变量；夹具端口缺省 6430～6436（--fixture-ports 可改）' }),
  PR21('V21-cut-online-br', '在线浏览器替剪辑段里的重卡产流（〔裁〕R02；切分方只切分，贴流与精确活渲比、与顶层同一张卡对照）',
    'cut-online-browser-probe', ['--dist', '{dist}', '--base-port', '5910', '--out', '{item}'],
    { needs: ['online-build'], timeoutMin: 40, known: '端口整段 5910～5919；R01（毛玻璃带着下层产流）2026-10-23 被用户推翻、返工删掉了它那支探针，这一支只验 R02' }),
  PR21('V21-media-cache', '舞台素材长期缓存与跨项目路径号隔离（缓存头、跨会话命中、旧路由每次回源、别的项目的路径号命中不了）',
    'media-cache-probe', [],
    { timeoutMin: 30, known: '真实无头 Chrome，自己起服务与两次会话；端口与临时的浏览器配置目录由探针自己管' }),
  PR21('V21-guest-readonly', '游客进别人的项目时编辑界面的只读呈现（R0 读写对照、R1 徽标、R2 时间轴、R3 参数面板、R4 标题栏、手机版说明条）',
    'guest-readonly-ui-probe', ['--port', '5243', '--out', '{item}'],
    { timeoutMin: 25, known: '探针端口段 5240～5249（自己起一台编辑器，舞台占 +1、+2），跑完收掉' }),
];
