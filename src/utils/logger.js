const fs = require('fs/promises');
const path = require('path');

function serialize(values) {
  return values
    .map((value) => {
      if (value instanceof Error) {
        return `${value.message}\n${value.stack || ''}`.trim();
      }

      if (typeof value === 'string') {
        return value;
      }

      try {
        return JSON.stringify(value);
      } catch (error) {
        return String(value);
      }
    })
    .join(' ');
}

function createLogger(logFile) {
  const resolvedLogFile = path.resolve(logFile);

  async function write(level, values) {
    const message = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${serialize(values)}`;

    if (level === 'error') {
      console.error(message);
    } else if (level === 'warn') {
      console.warn(message);
    } else {
      console.log(message);
    }

    await fs.mkdir(path.dirname(resolvedLogFile), { recursive: true });
    await fs.appendFile(resolvedLogFile, `${message}\n`);
  }

  return {
    info: (...values) => write('info', values),
    warn: (...values) => write('warn', values),
    error: (...values) => write('error', values),
  };
}

module.exports = {
  createLogger,
};
