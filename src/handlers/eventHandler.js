const fs = require('fs');
const path = require('path');

async function loadEvents(client) {
  const eventsPath = path.join(__dirname, '..', 'events');
  const eventFiles = fs.readdirSync(eventsPath).filter((fileName) => fileName.endsWith('.js'));

  for (const fileName of eventFiles) {
    const eventPath = path.join(eventsPath, fileName);
    const event = require(eventPath);

    if (!event.name || !event.execute) {
      console.warn(`Skipping invalid event module: ${fileName}`);
      continue;
    }

    if (event.once) {
      client.once(event.name, (...args) => event.execute(...args, client));
      continue;
    }

    client.on(event.name, (...args) => event.execute(...args, client));
  }
}

module.exports = {
  loadEvents,
};
