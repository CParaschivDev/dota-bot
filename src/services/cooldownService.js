class CooldownService {
  constructor() {
    this.cooldowns = new Map();
  }

  getKey(scope, userId) {
    return `${scope}:${userId}`;
  }

  getRemaining(scope, userId, durationMs) {
    const key = this.getKey(scope, userId);
    const expiresAt = this.cooldowns.get(key);

    if (!expiresAt) {
      return 0;
    }

    const remaining = expiresAt - Date.now();

    if (remaining <= 0) {
      this.cooldowns.delete(key);
      return 0;
    }

    return remaining;
  }

  use(scope, userId, durationMs) {
    const key = this.getKey(scope, userId);
    const expiresAt = Date.now() + durationMs;
    this.cooldowns.set(key, expiresAt);
    return expiresAt;
  }
}

module.exports = {
  CooldownService,
};
