const { config } = require('../config');

class BotControlClient {
  constructor(currentConfig = config) {
    this.config = currentConfig;
  }

  get isEnabled() {
    return Boolean(this.config.botControlUrl && this.config.botControlToken);
  }

  async post(pathname, payload) {
    if (!this.isEnabled) {
      throw new Error('Bot control API is not configured. Set BOT_CONTROL_TOKEN and BOT_CONTROL_URL.');
    }

    const url = new URL(pathname, this.config.botControlUrl);
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${this.config.botControlToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload || {}),
    });

    const data = await response.json().catch(() => ({ error: 'Invalid JSON response from bot control API.' }));

    if (!response.ok || data.ok === false) {
      throw new Error(data.error || `Bot control request failed (${response.status}).`);
    }

    return data.result;
  }
}

module.exports = {
  BotControlClient,
};
