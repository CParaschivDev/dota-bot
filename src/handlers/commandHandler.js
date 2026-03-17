const fs = require('fs');
const path = require('path');

async function loadCommands(client) {
  const commandsPath = path.join(__dirname, '..', 'commands');
  const commandFiles = fs
    .readdirSync(commandsPath)
    .filter((fileName) => fileName.endsWith('.js'));

  for (const fileName of commandFiles) {
    const commandPath = path.join(commandsPath, fileName);
    const command = require(commandPath);

    if (!command.data || !command.execute) {
      console.warn(`Skipping invalid command module: ${fileName}`);
      continue;
    }

    client.commands.set(command.data.name, command);
  }

  return Array.from(client.commands.values());
}

module.exports = {
  loadCommands,
};
