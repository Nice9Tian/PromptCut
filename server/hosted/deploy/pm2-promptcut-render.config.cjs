// 托管方渲染服务的 PM2 配置模板（契约 docs/plan/hosted-render-contract.md 第 7 节）。
// 部署脚本 `scripts/remote/docservice.mjs deploy-render` 用 server/hosted-render/deploy.mjs 的 renderPm2Config 填好占位符，
// 写成 {{DIR}}/pm2.config.cjs（仓库外）。手工重建时把花括号占位符（两层花括号括起来的大写名字）换成 server/hosted/deploy/README.md「渲染服务」一节表里的值。
// 不含任何秘密：服务私钥在 {{SECRETS}}/service-key.json（0600，目录 0700），不进环境变量，也不进这个文件。
module.exports = {
  apps: [
    {
      name: 'promptcut-render',
      // 入口是管理进程；它再起工作进程（scripts/render-host.mjs 的代理模式）。与 promptcut-hosted 互不重启
      script: 'server/hosted-render/main.mjs',
      // current 是指向 releases/<提交前 12 位> 的链接：升级与回退都是换链接再 pm2 startOrReload
      cwd: '{{DIR}}/current',
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      // 只量管理进程自己（Chrome 在子进程里，由 cgroup 或管理进程的看护管，见契约第 4 节）
      max_memory_restart: '{{MAX_MEMORY_RESTART}}',
      // 退出时管理进程要先放回认领、结束进程树
      kill_timeout: {{KILL_TIMEOUT_MS}},
      // 自检不过（退出码 78）就停着，不反复拉起；PM2 版本不认这个选项时见 README 的说明
      stop_exit_codes: [78],
      time: true,
      env: {
        NODE_ENV: 'production',
        PROMPTCUT_RENDER_DOC_URL: '{{DOC_URL}}',
        PROMPTCUT_RENDER_SECRETS: '{{SECRETS}}',
        PROMPTCUT_RENDER_DATA: '{{DATA}}',
        PROMPTCUT_RENDER_PORT: '{{WORKER_PORT}}',
        PROMPTCUT_RENDER_STATUS_PORT: '{{STATUS_PORT}}',
        PROMPTCUT_RENDER_MAX_CONCURRENT: '{{MAX_CONCURRENT}}',
        PROMPTCUT_RENDER_MAX_PROJECTS: '{{MAX_PROJECTS}}',
        PROMPTCUT_RENDER_MEMORY_MAX: '{{MEMORY_MAX}}',
        PROMPTCUT_RENDER_MEMORY_HIGH: '{{MEMORY_HIGH}}',
        PROMPTCUT_RENDER_CPU_QUOTA: '{{CPU_QUOTA}}',
        PROMPTCUT_RENDER_USER: '{{RENDER_USER}}',
        PROMPTCUT_RENDER_USER_CARDS: '{{USER_CARDS}}',
        // 看画面（云端 Agent 服务凭服务身份向管理进程要一帧）：on / off；核对它的签名用托管组合的服务登记表（只有公钥）
        PROMPTCUT_RENDER_LOOK: '{{LOOK}}',
        PROMPTCUT_RENDER_LOOK_SERVICES: '{{HOSTED_DATA}}/secrets/services.json',
        // 与在线页面同一个提交的核对：管理进程从这里读在线页面构建里嵌的代码版本
        PROMPTCUT_RENDER_EDITOR_DIR: '{{EDITOR_DIR}}',
        // Chrome（chrome-headless-shell）装在发布目录里，随 current 换代
        PUPPETEER_CACHE_DIR: '{{DIR}}/current/.cache/puppeteer',
      },
    },
  ],
};
