/**
 * 0.7.24 之后补进来的验收项（照 `v23-manifest.mjs` 的写法，字段含义见 `four-stage-manifest.mjs` 文件头）。
 *
 * 这一本眼下只有一项：编辑器登录页「用 Google 继续」的端到端。
 * 它补的是 0.7.24 发出去当天用户报的那条缺陷 —— 「用Google账号登录进不去，授权以后没有反应」：
 * 登录页里 Google 那一块和外面接业务层那一层是两条线各做一半，接缝上没有任何测试，
 * 于是「账号服务那边真的登成功了、页面却一动不动」只能等用户在生产上撞到。
 */
import '../lib/no-user-dirs.mjs';

const node = 'node';
const probe = (name, args = []) => [node, `scripts/probes/${name}.mjs`, ...args];
/** 账号后端那两个环境变量（和 `v21-manifest.mjs` 里 `account: true` 的那几项同一套） */
const ACCOUNT_ENV = ['PROMPTCUT_ACCOUNT_PROVIDER_ROOT', 'PROMPTCUT_PASSWORD_ORDER_MODULE'];

/** 0.7.24 之后的一支探针 */
function PR24(id, name, script, args, o = {}) {
  const { where = 'local', known, timeoutMin = 30, account = false, needs, covers } = o;
  return {
    id, name, category: 'V24', level: 'local',
    taskRef: o.taskRef || '0.7.24 之后的返工（docs/reports/REPORT-021.md「0.7.24 发出去当天：Google 登录进不去」一节）',
    where, tasks: [], cmd: probe(script, args), requires: [`scripts/probes/${script}.mjs`],
    covers: covers || [`${script}.mjs`],
    ...(account ? { requiresEnv: ACCOUNT_ENV } : {}), ...(known ? { known } : {}),
    ...(needs ? { needs } : {}),
    pass: { exit: 0 }, timeoutMin,
  };
}

/** 不进整套的探针文件与原因（`--check-coverage` 对照；并进 `four-stage-manifest.mjs` 的 EXCLUDED_PROBE_FILES） */
export const V24_EXCLUDED = {};

export const V24_ITEMS = [
  PR24('V24-google-login', '编辑器登录页「用 Google 继续」端到端：已关联过的账号点下去直接进开始页（顶上显示账号名）；没关联过的身份先让起一个账号名、建完同样进开始页；两条都核对真发生过 third-party/login（或 register）200 与 editor/session 200',
    'google-login-wire-probe', ['--dist', '{dist}', '--out', '{item}'],
    { needs: ['online-build'], account: true, timeoutMin: 20,
      known: '要账号后端的两个环境变量；端口段 6530～6539；带 PROMPTCUT_NO_PORT_FILE=1 跑。身份服务与 Google 的 gsi/client 两样是桩（不验签、按令牌字面认人；桩按 GIS 的约定收回调、画一颗真按钮），其余全是真进程，不需要真的 Google 账号' }),
];
