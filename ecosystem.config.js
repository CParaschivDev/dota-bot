module.exports = {
  apps: [
    {
      name: 'dota-bot',
      script: 'index.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'dota-web',
      script: 'web.js',
      instances: 1,
      autorestart: true,
      watch: false,
      max_memory_restart: '250M',
      env: {
        NODE_ENV: 'production',
      },
    },
    {
      name: 'dota-backup',
      script: 'scripts/backup-db.js',
      instances: 1,
      autorestart: false,
      cron_restart: '0 */6 * * *',
      watch: false,
      env: {
        NODE_ENV: 'production',
      },
    },
  ],
};
