// PM2 配置：远程主机上跑独立文档服务骨架。由 `scripts/remote/docservice.mjs deploy` 在部署目录里启动：
//   pm2 startOrReload server/docservice/ecosystem.config.cjs --update-env
const path = require('node:path');

module.exports = {
  apps: [{
    name: 'promptcut-docservice',
    script: 'server/docservice/main.mjs',
    cwd: path.resolve(__dirname, '../..'),
    env: {
      NODE_ENV: 'production',
      PROMPTCUT_DOCSERVICE_PORT: process.env.PROMPTCUT_DOCSERVICE_PORT ?? '8787',
      PROMPTCUT_DOCSERVICE_HOST: process.env.PROMPTCUT_DOCSERVICE_HOST ?? '0.0.0.0',
    },
    max_memory_restart: '256M',
    kill_timeout: 5000,
    time: true,
  }],
};
