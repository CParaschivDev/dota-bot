class DiscordAlertService {
  constructor(client, config, logger) {
    this.client = client;
    this.config = config;
    this.logger = logger;
  }

  isEnabled() {
    return Boolean(this.config.webAlertChannelId);
  }

  async getChannel() {
    if (!this.isEnabled() || !this.client) {
      return null;
    }

    return this.client.channels.fetch(this.config.webAlertChannelId).catch(() => null);
  }

  async sendAlert(title, lines) {
    if (!this.isEnabled()) {
      return false;
    }

    const channel = await this.getChannel();

    if (!channel || typeof channel.send !== 'function') {
      this.logger.warn(`Alert channel ${this.config.webAlertChannelId} is unavailable.`);
      return false;
    }

    const content = [`**${title}**`, ...lines.filter(Boolean)].join('\n');
    await channel.send({ content }).catch((error) => {
      this.logger.warn('Could not send Discord alert.', error);
    });
    return true;
  }

  async sendBackupFailure(error, context = {}) {
    return this.sendAlert('Backup Failure', [
      `Reason: ${context.reason || 'scheduled'}`,
      `Message: ${error && error.message ? error.message : String(error)}`,
    ]);
  }

  async sendAdminFailure(context = {}) {
    return this.sendAlert('Admin Action Failure', [
      `Guild: ${context.guildId || 'n/a'}`,
      `Action: ${context.action || 'n/a'}`,
      `Actor: ${context.actorLabel || context.actorId || 'n/a'}`,
      `Target: ${context.targetType || 'n/a'} ${context.targetId || ''}`.trim(),
      `Error: ${context.errorMessage || 'Unknown error'}`,
    ]);
  }
}

module.exports = {
  DiscordAlertService,
};
