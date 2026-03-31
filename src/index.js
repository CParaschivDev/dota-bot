const { Client, Collection, GatewayIntentBits } = require('discord.js');

const { config, validateConfig } = require('./config');
const { createDatabase } = require('./data/database');
const { createDefaultState } = require('./data/defaultState');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');
const { DotaGcLobbyService } = require('./services/dotaGcLobbyService');
const { BackupScheduler } = require('./services/backupScheduler');
const { DiscordAlertService } = require('./services/discordAlertService');
const { MatchmakingService } = require('./services/matchmakingService');
const { StratzService } = require('./services/stratzService');
const { WebAdminService } = require('./services/webAdminService');
const { StateService } = require('./services/stateService');
const { startBotControlServer } = require('./botControl');
const { JsonFileStore } = require('./utils/fileStore');
const { registerCommands } = require('./utils/registerCommands');
const { createRuntimeLogger } = require('./utils/runtimeLogger');

async function bootstrapBot(options = {}) {
  const currentConfig = options.config || config;
  const missing = validateConfig(currentConfig);

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(', ')}`);
  }

  const logger = options.logger || createRuntimeLogger('bot');
  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.commands = new Collection();
  client.config = currentConfig;

  const store = new JsonFileStore(currentConfig.dataFile, createDefaultState());
  const stateService = new StateService(store, currentConfig);
  await stateService.initialize();

  const database = options.database || (await createDatabase(currentConfig.databasePath));
  const ownsDatabase = !options.database;
  const steamLobby = options.steamLobby || new DotaGcLobbyService(currentConfig, logger);
  const statsProvider = options.statsProvider || new StratzService(currentConfig, logger);

  await steamLobby.start();

  const alertService = new DiscordAlertService(client, currentConfig, createRuntimeLogger('alerts'));
  const backupScheduler = options.backupScheduler || new BackupScheduler(currentConfig, createRuntimeLogger('backup'), alertService);

  const matchmakingService = new MatchmakingService(
    database,
    currentConfig,
    logger,
    statsProvider,
    steamLobby,
  );

  await matchmakingService.initialize();
  const webAdminService = new WebAdminService(matchmakingService, currentConfig, logger, alertService);
  const botControlRuntime = await startBotControlServer(webAdminService, {
    config: currentConfig,
    logger: createRuntimeLogger('bot-control'),
  });

  client.services = {
    state: stateService,
    matchmaking: matchmakingService,
    dotaLobby: steamLobby,
    statsProvider,
    webAdmin: webAdminService,
    backup: backupScheduler,
    alerts: alertService,
  };

  matchmakingService.bindClient(client);
  matchmakingService.startBackgroundJobs();
  await backupScheduler.start();

  const commands = await loadCommands(client);
  await loadEvents(client);

  const registrationScope = await registerCommands(
    currentConfig,
    commands.map((command) => command.data.toJSON()),
  );

  logger.info(`Registered ${commands.length} slash commands to ${registrationScope}.`);

  client.on('error', (error) => {
    logger.error('Discord client error.', error);
  });

  await client.login(currentConfig.token);

  async function close() {
    if (matchmakingService.readyCheckInterval) {
      clearInterval(matchmakingService.readyCheckInterval);
      matchmakingService.readyCheckInterval = null;
    }

    client.destroy();

    if (steamLobby && steamLobby.steamUser && typeof steamLobby.steamUser.logOff === 'function') {
      try {
        steamLobby.steamUser.logOff();
      } catch (error) {
        logger.warn('Could not log off the Steam client cleanly.', error);
      }
    }

    if (botControlRuntime) {
      await botControlRuntime.close();
    }

    if (backupScheduler) {
      await backupScheduler.stop();
    }

    if (ownsDatabase) {
      await database.close();
    }
  }

  return {
    client,
    database,
    logger,
    close,
  };
}

async function startFromCli() {
  const runtime = await bootstrapBot();

  const shutdown = async () => {
    try {
      await runtime.close();
    } finally {
      process.exit(0);
    }
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

module.exports = {
  bootstrapBot,
  startFromCli,
};
