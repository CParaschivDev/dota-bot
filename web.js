const { bootstrapWebServer } = require('./src/web');
const { createRuntimeLogger } = require('./src/utils/runtimeLogger');

bootstrapWebServer({ logger: createRuntimeLogger('web') })
  .then((runtime) => {
    const shutdown = async () => {
      try {
        await runtime.close();
      } finally {
        process.exit(0);
      }
    };

    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
  })
  .catch((error) => {
    console.error('Failed to start dashboard server.', error);
    process.exit(1);
  });
