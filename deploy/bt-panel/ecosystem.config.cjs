// PM2 ecosystem file. Usage on the server:
//   pm2 start deploy/bt-panel/ecosystem.config.cjs
//   pm2 save && pm2 startup
module.exports = {
  apps: [
    {
      name: "by-wave-calendar",
      cwd: ".",
      script: "dist/src/server.js",
      exec_mode: "fork",
      instances: 1,
      env: {
        NODE_ENV: "production",
      },
      max_memory_restart: "512M",
      out_file: "./logs/out.log",
      error_file: "./logs/err.log",
      merge_logs: true,
      time: true,
    },
  ],
};
