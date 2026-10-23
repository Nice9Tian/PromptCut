/**
 * 0.7.22 新进来的验收项（照 `v21-manifest.mjs` 的写法，字段含义见 `four-stage-manifest.mjs` 文件头）。
 *
 * 0.7.22 是 0.7.21 发出去之后的补丁版，只动 Node 那一半（外壳仍是 0.2.8，用户走更新补丁）。两件事：
 *
 *   1. **修**：全新游客点「新建项目」必被「这个项目名已被使用」挡死 —— 项目名在这个服务里是全站唯一的
 *      （`server/auth/protocol.mjs` 的 `nameKey`），而开始页的名字是机器取的（空白项目恒为「未命名」），
 *      第一个人建完之后所有人都撞。2026-10-23 线上实测回 409 `name-taken`。
 *   2. **氛围式那一格**（`claude/editor-vibe-button`）：顶栏工作方式开关从两格变三格、桌面版也有氛围式、
 *      详细编辑换成可调的真时间轴。
 *
 * 端口：本版两项都不起服务（一项是单元测试，一项不进整套），不占端口段。
 */
import '../lib/no-user-dirs.mjs';

const node = 'node';
const TEST_OK = '最终结果[:：]零失败';

/** 一组测试文件（npm test -- 文件…），判法照 `v19-manifest.mjs` 的 `T` */
function T22(id, name, files, o = {}) {
  const { where = 'local', known, timeoutMin = 10, covers } = o;
  return {
    id, name, category: 'V22', level: 'local',
    taskRef: o.taskRef || '0.7.22 发版（docs/reports/REPORT-021.md「0.7.22」一节）',
    where, tasks: [], cmd: [node, 'scripts/test-suite.mjs', ...files], requires: files,
    ...(covers ? { covers } : {}), ...(known ? { known } : {}),
    pass: {
      exit: 0, must: [TEST_OK],
      metrics: { tests: 'ℹ tests (\\d+)', pass: 'ℹ pass (\\d+)', fail: 'ℹ fail (\\d+)', skipped: 'ℹ skipped (\\d+)' },
      limits: { fail: { eq: 0 }, skipped: { eq: 0 }, tests: { min: 1 } }, todoFail: true,
    },
    timeoutMin,
  };
}

/** 不进整套的探针文件与原因（`--check-coverage` 对照；并进 `four-stage-manifest.mjs` 的 EXCLUDED_PROBE_FILES） */
export const V22_EXCLUDED = {
  'vibe-desktop-probe.mjs': '桌面版氛围式的探针（`claude/editor-vibe-button`）：它跑在**真的 Tauri 壳窗口**里——要先在工作区起一个 vite dev server，再启动 promptcut.exe，然后把 WebView2 的调试端口用 `--cdp` 交给它。整套验收跑的是在线产物（`--dist`），起不了壳、也拿不到那个端口，所以不进整套；跑法写在探针文件头。作者 2026-10-23 在真壳里跑过十二步 `{"ok":true,"fails":[]}`（本机 Claude Code 真接上并跑出 10 个片段、拖一段 start 1→2.2、右键菜单九项），证据与截图在 docs/archive/agent-reports/AGENT-claude-editor-vibe-button.md',
};

export const V22_ITEMS = [
  T22('V22-project-name', '开始页自动取的项目名避开重名（撞了自动换一个再试：原名 → 原名 2…原名 5 → 原名 + 四位随机；只对 name-taken 重试，游客超额/没登录/网络断照原样抛）',
    ['src/start/format.test.mjs'],
    { covers: [], known: '纯单元测试，不起服务、不占端口' }),
];
