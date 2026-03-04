module.exports = {
  apps: [
    {
      name: "steward",
      script: "npm",
      args: "run start -- -p 3010",
      cwd: __dirname,
      env: {
        NODE_ENV: "production",
      },
      autorestart: true,
      watch: false,
      max_restarts: 10,
      restart_delay: 3000,
    },
  ],
};
