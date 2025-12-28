module.exports = {
  apps: [{
    name: 'polymarket-copy-bot',
    script: 'dist/index.js',
    instances: 1,
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    env: {
      NODE_ENV: 'production'
    },
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    restart_delay: 4000,
    min_uptime: '10s',
    max_restarts: 10,
    kill_timeout: 3000,
    wait_ready: false,
    listen_timeout: 3000
  }]
};
