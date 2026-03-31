const http = require('http');

const { config } = require('../config');
const { createRuntimeLogger } = require('../utils/runtimeLogger');

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(payload));
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch (error) {
    throw createHttpError(400, 'Request body must be valid JSON.');
  }
}

function requireToken(request, currentConfig) {
  const expectedToken = currentConfig.botControlToken;

  if (!expectedToken) {
    throw createHttpError(503, 'BOT_CONTROL_TOKEN is not configured.');
  }

  const providedToken = request.headers.authorization && request.headers.authorization.startsWith('Bearer ')
    ? request.headers.authorization.slice('Bearer '.length)
    : request.headers['x-admin-token'];

  if (providedToken !== expectedToken) {
    throw createHttpError(401, 'Unauthorized.');
  }
}

function createHandler(webAdminService, currentConfig, logger) {
  return async function handleRequest(request, response) {
    const host = request.headers.host || `${currentConfig.botControlHost}:${currentConfig.botControlPort}`;
    const url = new URL(request.url || '/', `http://${host}`);

    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      requireToken(request, currentConfig);

      if (request.method !== 'POST') {
        throw createHttpError(405, 'Only POST is supported.');
      }

      const body = await readJsonBody(request);
      const actorId = body.actorId || currentConfig.webAdminActorId || 'web-admin';
      const payload = {
        ...body,
        actorId,
      };

      let result;

      switch (url.pathname) {
        case '/admin/report-result':
          result = await webAdminService.reportResult(payload);
          break;
        case '/admin/confirm-result':
          result = await webAdminService.confirmResult(payload);
          break;
        case '/admin/deny-result':
          result = await webAdminService.denyResult(payload);
          break;
        case '/admin/submit-stratz':
          result = await webAdminService.submitStratzResult(payload);
          break;
        case '/admin/set-host':
          result = await webAdminService.setHost(payload);
          break;
        case '/admin/set-captain':
          result = await webAdminService.setCaptain(payload);
          break;
        case '/admin/set-elo':
          result = await webAdminService.setElo(payload);
          break;
        case '/admin/cancel-match':
          result = await webAdminService.cancelMatch(payload);
          break;
        case '/admin/undo-report':
          result = await webAdminService.undoReport(payload);
          break;
        case '/admin/create-backup':
          result = await webAdminService.createBackup(payload);
          break;
        case '/admin/restore-backup':
          result = await webAdminService.restoreBackup(payload);
          break;
        case '/admin/list-backups':
          result = await webAdminService.listBackups(payload);
          break;
        default:
          throw createHttpError(404, 'Route not found.');
      }

      sendJson(response, 200, {
        ok: true,
        result,
      });
    } catch (error) {
      const statusCode = Number.isInteger(error.statusCode) ? error.statusCode : 500;

      if (statusCode >= 500) {
        logger.error('Bot control request failed', error);
      }

      sendJson(response, statusCode, {
        ok: false,
        error: error.message || 'Unexpected error.',
      });
    }
  };
}

async function startBotControlServer(webAdminService, options = {}) {
  const currentConfig = options.config || config;
  const logger = options.logger || createRuntimeLogger('bot-control');
  const server = http.createServer(createHandler(webAdminService, currentConfig, logger));

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(currentConfig.botControlPort, currentConfig.botControlHost, resolve);
  });

  logger.info(`Bot control API available at http://${currentConfig.botControlHost}:${currentConfig.botControlPort}`);

  return {
    server,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    },
  };
}

module.exports = {
  startBotControlServer,
};
