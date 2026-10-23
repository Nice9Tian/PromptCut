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
 * **与 `claude/probe-audit` 的合并须知（2026-10-23）**：那条分支（探针总审与清理，基准 `2249179a`）把
 * `cut-online-browser-probe`、`account-direct-address-probe`、`update-notice-probe` 三支写进了
 * `v19-manifest.mjs` 的 `V19_EXCLUDED`（排除、不跑）。本文件把它们登记成**会跑的验收项**，更严。
 * 两边合并时**以本文件为准**：把那三行从 `V19_EXCLUDED` 里去掉，保留这里的 V21 项。
 * 那条分支还给 `coverageReport()` 加了一条新检查——同一支探针**既被清单项 `covers` 点名、又写在排除表里**就判红
 * （原先静默通过）。所以上面那三行不去掉，合完守门必红；去掉即通过。它基准（`2249179a`）之后合进来的探针
 * （`media-cache-probe`、`guest-readonly-ui-probe`、`drive-range-probe.html` 等）它那边没有，合完按它报出来的未登记项补即可。
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

/** 不进整套的探针文件与原因（`--check-coverage` 对照；并进 `four-stage-manifest.mjs` 的 EXCLUDED_PROBE_FILES） */
export const V21_EXCLUDED = {
  'drive-range-probe.html': '网盘连接器 D1 的可行性探针页（`claude/drive-connector`）：要人在浏览器里用真实 Google 账号点完授权、选文件，脚本跑不了。结论（drive.file 够用、files.get?alt=media 支持 Range）已落进 docs/plan/drive-connector-task.md 第 6.1 节。网盘连接器这个功能不随 0.7.21 发（〔裁〕V21-18），它的自动化验收随功能本身那一版建',
};

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
  PR21('V21-guest-enter', '游客进自己的云端项目（G1 领身份、G2 新建后进编辑器、G3 成员浮层里是「游客-XXXX（自己）」、G4 导入图片写进文档服务、G5 刷新后自动回到项目且图片还在、G6 从开始页点自己的项目、G7 一路没有「请先登录账号」）',
    'guest-enter-e2e-probe', ['--dist', '{dist}', '--out', '{item}'],
    { needs: ['online-build'], account: true, timeoutMin: 20, taskRef: '0.7.21 线上返工（claude/guest-enter，docs/reports/AGENT-claude-guest-enter.md）',
      known: '要账号后端的两个环境变量；夹具端口缺省 6490～6496（--fixture-ports 可改）；跑的时候带 PROMPTCUT_NO_PORT_FILE=1' }),
  PR21('V21-clip-speed-export', '片段速度的导出端到端（按「素材时刻 = mediaOffset + (t − start) × 速度」取帧；变速段不出原声；分离出来的变速声音段两条混音路一致）',
    'clip-speed-export-probe', ['--port', '5920', '--out', '{item}'],
    { timeoutMin: 40, known: '端口 5920 起；自己起开发服务器并带 PROMPTCUT_NO_PORT_FILE=1，素材与数据目录都建在 --out 下' }),
  PR21('V21-clip-speed-keys', '片段速度的身份键比对（缺省 1 倍时与改之前逐字相同；改了速度该变的键都变）',
    'clip-speed-key-compare', ['--base', '5a8f375a'],
    { timeoutMin: 20, known: '--base 给开工提交；输出 57 项逐字对照' }),
  PR21('V21-clip-speed-ui', '片段速度的界面（桌面编辑分区一栏与手机速度面板、手动输入倍率、超范围拒绝、挂转场改速度的气泡）',
    'clip-speed-ui-probe', ['--dist', '{dist}', '--out', '{item}', '--base-port', '5930', '--doc-port', '5936', '--asset-port', '5937'],
    { needs: ['online-build'], timeoutMin: 30, known: '端口 5930 起，文档服务 5936、素材服务 5937' }),
];
