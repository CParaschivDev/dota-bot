const { startFromCli } = require('./src/index');

startFromCli().catch((error) => {
  console.error('Failed to start Dota bot.', error);
  process.exit(1);
});
