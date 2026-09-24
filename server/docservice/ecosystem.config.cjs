// PM2 配置：远程主机上跑独立文档服务。由 `scripts/remote/docservice.mjs deploy` 在部署目录里启动：
//   pm2 startOrReload server/docservice/ecosystem.config.cjs --update-env
// 集群令牌 PROMPTCUT_CLUSTER_TOKEN 由部署脚本经 ssh 标准输入 export 进来，这里只透传，不写值。
// 远端绑 0.0.0.0，没有令牌时 main.mjs 会拒绝启动（契约 G.5「失败即关」）。
const path = require('node:path');

const env = {
  NODE_ENV: 'production',
  PROMPTCUT_DOCSERVICE_PORT: process.env.PROMPTCUT_DOCSERVICE_PORT ?? '8787',
  PROMPTCUT_DOCSERVICE_HOST: process.env.PROMPTCUT_DOCSERVICE_HOST ?? '0.0.0.0',
};
if (process.env.PROMPTCUT_CLUSTER_TOKEN !== undefined) env.PROMPTCUT_CLUSTER_TOKEN = process.env.PROMPTCUT_CLUSTER_TOKEN;

module.exports = {
  apps: [{
    name: 'promptcut-docservice',
    script: 'server/docservice/main.mjs',
    cwd: path.resolve(__dirname, '../..'),
    env,
    max_memory_restart: '256M',
    kill_timeout: 5000,
    time: true,
  }],
};
