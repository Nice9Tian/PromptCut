/**
 * nginx 模板里与「在线执行用户卡与图卡」的隔离有关的两个片段(契约 `docs/plan/online-card-exec-contract.md` 第 3.3 节)。
 * 策略原文取自 `src/online/stagePolicy.mjs`,与在线构建的 `<meta>`、本机代理同出一处;这里只负责写成 nginx 的 `add_header`。
 *
 *   node scripts/gen-stage-policy-nginx.mjs            重新生成 `server/hosted/deploy/` 下的两个片段
 *   node scripts/gen-stage-policy-nginx.mjs --check    只核对(与生成结果不一致就退出码 1)
 *
 * 单测 `server/test/stage-policy-nginx.test.mjs` 核对仓库里的片段与这里生成的逐字相同。占位符 `{{DOMAIN}}` 原样留在片段里,
 * 部署时与站点配置一起替换(`server/hosted/deploy/README.md`)。
 */
import { editorSecurityHeaders, stageSecurityHeaders } from '../../src/online/stagePolicy.mjs';

export const STAGE_HEADERS_SNIPPET_FILE = 'nginx-snippet-promptcut-stage-headers.conf';
export const EDITOR_POLICY_SNIPPET_FILE = 'nginx-snippet-promptcut-editor-policy.conf';

/** 响应头的规范写法(nginx 原样发出;浏览器不分大小写) */
const NAME = {
  'content-security-policy': 'Content-Security-Policy',
  'connection-allowlist': 'Connection-Allowlist',
  'x-dns-prefetch-control': 'X-DNS-Prefetch-Control',
  'origin-agent-cluster': 'Origin-Agent-Cluster',
  'referrer-policy': 'Referrer-Policy',
  'x-content-type-options': 'X-Content-Type-Options',
};

function addHeaderLines(headers) {
  return Object.entries(headers).map(([k, v]) => {
    if (/["\\$\n]/.test(v)) throw new Error(`响应头 ${k} 的值里有 nginx 字符串不能直接放的字符`);
    return `add_header ${NAME[k] ?? k} "${v}" always;`;
  });
}

/** 舞台源(s1 / s2)上每个 location 都 include 的那一份:策略、出口白名单、关 DNS 预解析,以及原有的三条 */
export function stageHeadersSnippet() {
  return [
    '# 由 scripts/gen-stage-policy-nginx.mjs 生成,不要手改;策略原文在 src/online/stagePolicy.mjs。',
    '# 舞台源(s1 / s2)的 server 块里每个 location 都 include 这一份(nginx 的 add_header 不跨层合并:location 里只要有一条',
    '# add_header,server 层的就全不继承,所以放在 location 里 include,与该 location 自己的 Cache-Control 并列)。',
    ...addHeaderLines(stageSecurityHeaders('https://{{DOMAIN}}', { template: true })),
    '',
  ].join('\n');
}

/** 编辑器页(主站)的 /editor 各 location include 的那一份:只有 `frame-src` 一条 */
export function editorPolicySnippet() {
  return [
    '# 由 scripts/gen-stage-policy-nginx.mjs 生成,不要手改;策略原文在 src/online/stagePolicy.mjs。',
    '# 主站 /editor 的各个 location include 这一份:舞台 iframe 只能载入本源与两个舞台源(它自己跳走也归这条管)。',
    ...addHeaderLines(editorSecurityHeaders(['https://s1.{{DOMAIN}}', 'https://s2.{{DOMAIN}}'], { template: true })),
    '',
  ].join('\n');
}

export function stagePolicySnippets() {
  return { [STAGE_HEADERS_SNIPPET_FILE]: stageHeadersSnippet(), [EDITOR_POLICY_SNIPPET_FILE]: editorPolicySnippet() };
}
