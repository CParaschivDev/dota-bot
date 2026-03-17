const { Client, Collection, GatewayIntentBits } = require('discord.js');

const { config, validateConfig } = require('./config');
const { loadCommands } = require('./handlers/commandHandler');
const { loadEvents } = require('./handlers/eventHandler');
const { StateService } = require('./services/stateService');
const { createDefaultState } = require('./data/defaultState');
const { JsonFileStore } = require('./utils/fileStore');
const { registerCommands } = require('./utils/registerCommands');

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

  const store = new JsonFileStore(config.dataFile, createDefaultState());
  const stateService = new StateService(store, config);

  await stateService.initialize();

  client.services = {
    state: stateService,
  };

  const commands = await loadCommands(client);
  await loadEvents(client);

  const registrationScope = await registerCommands(
    config,
    commands.map((command) => command.data.toJSON()),
  );

  console.log(`Registered ${commands.length} slash commands to ${registrationScope}.`);

  await client.login(config.token);
}

bootstrap().catch((error) => {
  console.error('Failed to start Dota bot.', error);
  process.exit(1);
});
