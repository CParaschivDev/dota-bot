const fs = require('fs');
const path = require('path');

function createLiveUpdateHub(options) {
  const logger = options.logger;
  const databasePath = path.resolve(options.databasePath);
  const directory = path.dirname(databasePath);
  const baseName = path.basename(databasePath).toLowerCase();
  const watchedNames = new Set([
    baseName,
    `${baseName}-wal`,
    `${baseName}-shm`,
  ]);
  const clients = new Set();
  const heartbeatMs = options.heartbeatMs;
  const debounceMs = options.debounceMs;
  let watcher = null;
  let heartbeat = null;
  let debounceTimer = null;
  let sequence = 0;

  function sendEvent(client, eventName, payload) {
    try {
      client.response.write(`event: ${eventName}\n`);
      client.response.write(`id: ${sequence}\n`);
      client.response.write(`data: ${JSON.stringify(payload)}\n\n`);
    } catch (error) {
      clients.delete(client);
    }
  }

  function broadcast(reason = 'refresh', guildId = null) {
    sequence += 1;
    const payload = {
      reason,
      guildId,
      sequence,
      timestamp: new Date().toISOString(),
    };

    for (const client of clients) {
      if (guildId && client.guildId && client.guildId !== guildId) {
        continue;
      }

      sendEvent(client, 'dashboard:update', payload);
    }
  }

  function scheduleBroadcast(reason = 'db-change') {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
    }

    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      broadcast(reason);
    }, debounceMs);

    if (typeof debounceTimer.unref === 'function') {
      debounceTimer.unref();
    }
  }

  function handleFileEvent(fileName) {
    if (!fileName) {
      scheduleBroadcast('db-change');
      return;
    }

    if (watchedNames.has(String(fileName).toLowerCase())) {
      scheduleBroadcast('db-change');
    }
  }

  function attachClient(request, response, guildId) {
    response.writeHead(200, {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
      'X-Accel-Buffering': 'no',
    });

    const client = {
      response,
      guildId: guildId || null,
    };

    clients.add(client);
    sequence += 1;
    response.write(`retry: 2000\n`);
    response.write(`event: connected\n`);
    response.write(`id: ${sequence}\n`);
    response.write(`data: ${JSON.stringify({ guildId: guildId || null, sequence, timestamp: new Date().toISOString() })}\n\n`);

    request.on('close', () => {
      clients.delete(client);
    });
  }

  function start() {
    try {
      watcher = fs.watch(directory, { persistent: false }, (eventType, fileName) => {
        handleFileEvent(fileName);
      });
    } catch (error) {
      if (logger) {
        logger.warn(`Could not watch database directory ${directory} for live updates.`, error);
      }
    }

    heartbeat = setInterval(() => {
      sequence += 1;

      for (const client of clients) {
        sendEvent(client, 'heartbeat', {
          sequence,
          timestamp: new Date().toISOString(),
        });
      }
    }, heartbeatMs);

    if (typeof heartbeat.unref === 'function') {
      heartbeat.unref();
    }
  }

  async function close() {
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      debounceTimer = null;
    }

    if (watcher) {
      watcher.close();
      watcher = null;
    }

    if (heartbeat) {
      clearInterval(heartbeat);
      heartbeat = null;
    }

    for (const client of clients) {
      try {
        client.response.end();
      } catch (error) {
        // ignore
      }
    }

    clients.clear();
  }

  return {
    attachClient,
    broadcast,
    close,
    start,
  };
}

module.exports = {
  createLiveUpdateHub,
};
