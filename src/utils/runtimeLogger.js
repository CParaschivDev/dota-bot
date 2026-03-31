function serializeValue(value) {
  if (value instanceof Error) {
    return value.stack || value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch (error) {
    return String(value);
  }
}

function createRuntimeLogger(scope = 'app') {
  const debugEnabled = (process.env.LOG_LEVEL || '').toLowerCase() === 'debug' || process.env.NODE_ENV !== 'production';

  function write(level, values) {
    if (level === 'debug' && !debugEnabled) {
      return;
    }

    const timestamp = new Date().toISOString();
    const message = values.map(serializeValue).join(' ');
    const line = `[${timestamp}] [${scope}] [${level.toUpperCase()}] ${message}`;

    if (level === 'error') {
      console.error(line);
      return;
    }

    if (level === 'warn') {
      console.warn(line);
      return;
    }

    console.log(line);
  }

  return {
    info: (...values) => write('info', values),
    warn: (...values) => write('warn', values),
    error: (...values) => write('error', values),
    debug: (...values) => write('debug', values),
  };
}

module.exports = {
  createRuntimeLogger,
};
