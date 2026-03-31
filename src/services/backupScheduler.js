const { createBackup } = require('../utils/databaseBackup');

class BackupScheduler {
  constructor(config, logger, alertService = null) {
    this.config = config;
    this.logger = logger;
    this.alertService = alertService;
    this.interval = null;
  }

  get intervalMs() {
    return Math.max(1, Number(this.config.backupIntervalMinutes) || 360) * 60 * 1000;
  }

  async runBackup(reason = 'scheduled') {
    const result = await createBackup({
      databasePath: this.config.databasePath,
      backupDirectory: this.config.backupDirectory,
      retentionCount: this.config.backupRetentionCount,
      prefix: 'dota-bot',
    });

    this.logger.info(`Database backup completed (${reason}) at ${result.destination}`);
    return result;
  }

  async start() {
    if (this.config.backupOnStartup) {
      try {
        await this.runBackup('startup');
      } catch (error) {
        this.logger.error('Startup backup failed.', error);
        if (this.alertService) {
          await this.alertService.sendBackupFailure(error, { reason: 'startup' });
        }
      }
    }

    this.interval = setInterval(() => {
      this.runBackup().catch((error) => {
        this.logger.error('Scheduled backup failed.', error);
        if (this.alertService) {
          this.alertService.sendBackupFailure(error, { reason: 'scheduled' }).catch(() => null);
        }
      });
    }, this.intervalMs);

    if (typeof this.interval.unref === 'function') {
      this.interval.unref();
    }
  }

  async stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }
}

module.exports = {
  BackupScheduler,
};
