/**
 * pm2 服务托管（开发容器无 systemd 的正规化方案）。
 *   pnpm i -g pm2 && pm2 start ecosystem.config.cjs && pm2 save
 * 环境变量：server 从 packages/server/.env 读（tsx --env-file）；runner 在此注入。
 */

const ROOT = __dirname;

module.exports = {
  apps: [
    {
      name: 'co-server',
      cwd: `${ROOT}/packages/server`,
      script: `${ROOT}/node_modules/.bin/tsx`,
      args: '--env-file-if-exists=.env src/index.ts',
      env: { RUN_MIGRATIONS: '0' }, // 现有库由 drizzle push 演进而来，迁移基线见 deploy/README.md
      max_restarts: 10,
      restart_delay: 3000,
      out_file: `${ROOT}/.pm2-logs/co-server.out.log`,
      error_file: `${ROOT}/.pm2-logs/co-server.err.log`,
    },
    {
      name: 'co-runner',
      cwd: ROOT,
      script: `${ROOT}/node_modules/.bin/tsx`,
      args: 'packages/runner/src/index.ts',
      env: {
        SERVER_URL: process.env.SERVER_URL || 'ws://127.0.0.1:7620/ws/runner',
        MACHINE_LABELS: process.env.MACHINE_LABELS || 'dev',
        // 本机数据根：co 在 <DATA_ROOT>/co/ 下铺物化与组件缓存（/root/co/ 既有布局）
        DATA_ROOT: process.env.DATA_ROOT || '/root',
        // 本机 code-server 地址（网页"在编辑器打开"深链用），按需设 CODE_SERVER_URL
        CODE_SERVER_URL: process.env.CODE_SERVER_URL || '',
      },
      max_restarts: 10,
      restart_delay: 3000,
      out_file: `${ROOT}/.pm2-logs/co-runner.out.log`,
      error_file: `${ROOT}/.pm2-logs/co-runner.err.log`,
    },
    {
      name: 'code-server',
      script: '/usr/local/bin/code-server',
      interpreter: 'none', // shell 包装脚本，不能按 node 模块加载
      max_restarts: 10,
      restart_delay: 3000,
      out_file: `${ROOT}/.pm2-logs/code-server.out.log`,
      error_file: `${ROOT}/.pm2-logs/code-server.err.log`,
    },
  ],
};
