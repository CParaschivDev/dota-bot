function parseAuditDetails(value) {
  if (!value) {
    return null;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function toSafeObject(value) {
  if (!value || typeof value !== 'object') {
    return {};
  }

  return value;
}

function buildActorSource(body, authContext, currentConfig) {
  if (authContext && authContext.session) {
    return 'discord_oauth';
  }

  if (body && body.actorSource) {
    return String(body.actorSource);
  }

  if (currentConfig.webAdminToken) {
    return 'manual_token';
  }

  return 'system';
}

function buildActorLabel(body, authContext) {
  if (authContext && authContext.session && authContext.session.user) {
    const user = authContext.session.user;
    return user.globalName || user.username || user.id;
  }

  if (body && body.actorLabel) {
    return String(body.actorLabel);
  }

  return null;
}

module.exports = {
  buildActorLabel,
  buildActorSource,
  parseAuditDetails,
  toSafeObject,
};
