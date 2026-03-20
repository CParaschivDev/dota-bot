const { Client, Collection, GatewayIntentBits } = require('discord.js');

const { config, validateConfig } = require('./config');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');
const { StateService } = require('./services/stateService');
const { MatchmakingService } = require('./services/matchmakingService');
const { DotaGcLobbyService } = require('./services/dotaGcLobbyService');
const { createDefaultState } = require('./data/defaultState');
const { JsonFileStore } = require('./utils/fileStore');
const { registerCommands } = require('./utils/registerCommands');
const { createDatabase } = require('./data/database');

async function bootstrap() {
  const missing = validateConfig(config);

  if (missing.length > 0) {
    console.error(`Missing required environment variables: ${missing.join(', ')}`);
    console.error('Update C:/dota-bot/.env, then run `node index.js` again.');
    process.exit(1);
  }

  const client = new Client({
    intents: [GatewayIntentBits.Guilds],
  });

  client.commands = new Collection();
  client.config = config;

  // Create a simple logger
  const logger = {
    info: (msg) => console.log(`[INFO] ${msg}`),
    debug: (msg) => console.log(`[DEBUG] ${msg}`),
    error: (msg, error) => console.error(`[ERROR] ${msg}`, error || ''),
    warn: (msg) => console.warn(`[WARN] ${msg}`),
  };

  const store = new JsonFileStore(config.dataFile, createDefaultState());
  const stateService = new StateService(store, config);

  await stateService.initialize();

  // Initialize Steam lobby service
  const steamLobby = new DotaGcLobbyService(config, logger);
  await steamLobby.start();

  // Initialize sqlite database and pass it into MatchmakingService. Keep JsonFileStore
  // for StateService (separate JSON-based state).
  const database = await createDatabase(config.databasePath || config.databasePath);

  // Initialize matchmaking service with steam lobby and sqlite database
  const matchmakingService = new MatchmakingService(
    database,
    config,
    logger,
    null, // openDota - not initialized here, can be added if needed
    steamLobby,
  );

  await matchmakingService.initialize();

  client.services = {
    state: stateService,
    matchmaking: matchmakingService,
    dotaLobby: steamLobby,
  };

  // Bind client to matchmaking service so it can access Discord API
  matchmakingService.bindClient(client);
  matchmakingService.startBackgroundJobs();

  const commands = await loadCommands(client);
  await loadEvents(client);

  const registrationScope = await registerCommands(
    config,
    commands.map((command) => command.data.toJSON()),
  );

  console.log(`Registered ${commands.length} slash commands to ${registrationScope}.`);

  client.on('error', (error) => {
    logger.error('Discord client error.', error);
  });

  await client.login(config.token);
}

bootstrap().catch((error) => {
  console.error('Failed to start Dota bot.', error);
  process.exit(1);
});
