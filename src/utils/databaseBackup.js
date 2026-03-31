const fs = require('fs/promises');
const path = require('path');

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

function resolveBackupConfig(env = process.env, cwd = process.cwd()) {
  return {
    databasePath: path.resolve(cwd, env.DATABASE_PATH || './src/data/dota-bot.sqlite'),
    backupDirectory: path.resolve(cwd, env.BACKUP_DIRECTORY || './backups'),
    retentionCount: Number(env.BACKUP_RETENTION_COUNT) || 15,
    intervalMinutes: Number(env.BACKUP_INTERVAL_MINUTES) || 360,
    onStartup: String(env.BACKUP_ON_STARTUP || 'true').toLowerCase() === 'true',
  };
}

function makeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function escapeSqlitePath(value) {
  return String(value).replace(/'/g, "''");
}

async function ensureDirectory(directoryPath) {
  await fs.mkdir(directoryPath, { recursive: true });
}

function normalizeBackupFileName(fileName) {
  const normalized = path.basename(String(fileName || '').trim());

  if (!normalized || normalized !== String(fileName || '').trim()) {
    throw new Error('Invalid backup file name.');
  }

  if (!normalized.endsWith('.sqlite')) {
    throw new Error('Backup file must end with .sqlite.');
  }

  return normalized;
}

async function pruneOldBackups(directory, retentionCount, prefix = 'dota-bot') {
  if (!Number.isInteger(retentionCount) || retentionCount <= 0) {
    return [];
  }

  const entries = await fs.readdir(directory, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith(`${prefix}-`) && entry.name.endsWith('.sqlite'))
    .map((entry) => entry.name)
    .sort()
    .reverse();

  const stale = backups.slice(retentionCount);

  await Promise.all(stale.map((fileName) => fs.unlink(path.join(directory, fileName))));
  return stale;
}

async function verifySqliteFile(filePath) {
  const db = await open({
    filename: path.resolve(filePath),
    driver: sqlite3.Database,
  });

  try {
    const row = await db.get('PRAGMA integrity_check;');
    const status = row && Object.values(row)[0];

    if (status !== 'ok') {
      throw new Error(`SQLite integrity check failed: ${status || 'unknown result'}`);
    }

    return true;
  } finally {
    await db.close();
  }
}

async function listBackups(directory, prefix) {
  const resolvedDirectory = path.resolve(directory);

  await ensureDirectory(resolvedDirectory);

  const entries = await fs.readdir(resolvedDirectory, { withFileTypes: true });
  const filtered = entries.filter((entry) => {
    if (!entry.isFile() || !entry.name.endsWith('.sqlite')) {
      return false;
    }

    if (!prefix) {
      return true;
    }

    return entry.name.startsWith(`${prefix}-`) || entry.name.startsWith('pre-restore-');
  });

  const backups = await Promise.all(
    filtered.map(async (entry) => {
      const absolutePath = path.join(resolvedDirectory, entry.name);
      const stats = await fs.stat(absolutePath);

      return {
        fileName: entry.name,
        absolutePath,
        sizeBytes: Number(stats.size || 0),
        createdAt: stats.birthtime ? stats.birthtime.toISOString() : stats.mtime.toISOString(),
        updatedAt: stats.mtime.toISOString(),
      };
    }),
  );

  backups.sort((left, right) => right.fileName.localeCompare(left.fileName));
  return backups;
}

async function resolveBackupFile(directory, fileName) {
  const resolvedDirectory = path.resolve(directory);
  const normalizedName = normalizeBackupFileName(fileName);
  const absolutePath = path.join(resolvedDirectory, normalizedName);
  const stats = await fs.stat(absolutePath).catch(() => null);

  if (!stats || !stats.isFile()) {
    throw new Error(`Backup ${normalizedName} was not found.`);
  }

  return {
    fileName: normalizedName,
    absolutePath,
    sizeBytes: Number(stats.size || 0),
    createdAt: stats.birthtime ? stats.birthtime.toISOString() : stats.mtime.toISOString(),
    updatedAt: stats.mtime.toISOString(),
  };
}

function getRawDatabaseInstance(database) {
  if (!database || !database.db) {
    throw new Error('Database instance is unavailable.');
  }

  if (typeof database.db.getDatabaseInstance === 'function') {
    return database.db.getDatabaseInstance();
  }

  if (database.db.db) {
    return database.db.db;
  }

  return database.db;
}

async function restoreBackupIntoDatabase(options) {
  const backupFile = await resolveBackupFile(options.backupDirectory, options.backupFileName);
  await verifySqliteFile(backupFile.absolutePath);

  const safetyCopy = await createBackup({
    databasePath: options.databasePath,
    backupDirectory: options.backupDirectory,
    retentionCount: options.retentionCount,
    prefix: options.safetyPrefix || 'pre-restore',
  });

  const rawDatabase = getRawDatabaseInstance(options.database);

  await new Promise((resolve, reject) => {
    const backup = rawDatabase.backup(backupFile.absolutePath, 'main', 'main', false, (error) => {
      if (error) {
        reject(error);
        return;
      }

      const attemptStep = (attempt) => {
        backup.step(-1, (stepError, completed) => {
          if (!stepError && completed) {
            resolve();
            return;
          }

          if (!stepError) {
            attemptStep(attempt + 1);
            return;
          }

          const errorCode = String(stepError.code || stepError.errno || stepError.message || '');
          const isRetryable = /SQLITE_BUSY|SQLITE_LOCKED|\b5\b|\b6\b/.test(errorCode);

          if (isRetryable && attempt < 20) {
            setTimeout(() => attemptStep(attempt + 1), 250);
            return;
          }

          reject(stepError);
        });
      };

      attemptStep(0);
    });

    backup.retryErrors = [];
  });

  if (options.database && typeof options.database.exec === 'function') {
    await options.database.exec('PRAGMA wal_checkpoint(TRUNCATE);').catch(() => null);
    await options.database.exec('PRAGMA optimize;').catch(() => null);
  }

  await verifySqliteFile(options.databasePath);

  return {
    restoredFrom: backupFile.fileName,
    restoredPath: backupFile.absolutePath,
    safetyCopy,
  };
}

async function createBackup(options) {
  const databasePath = path.resolve(options.databasePath);
  const backupDirectory = path.resolve(options.backupDirectory);
  const prefix = options.prefix || 'dota-bot';
  const retentionCount = Number.isInteger(options.retentionCount) ? options.retentionCount : 15;

  await ensureDirectory(backupDirectory);

  const timestamp = makeTimestamp();
  const fileName = `${prefix}-${timestamp}.sqlite`;
  const destination = path.join(backupDirectory, fileName);

  const db = await open({
    filename: databasePath,
    driver: sqlite3.Database,
  });

  try {
    await db.exec('PRAGMA busy_timeout = 5000;');
    await db.exec(`VACUUM INTO '${escapeSqlitePath(destination)}';`);
  } finally {
    await db.close();
  }

  await verifySqliteFile(destination);
  const prunedFiles = await pruneOldBackups(backupDirectory, retentionCount, prefix);

  return {
    destination,
    fileName,
    prunedFiles,
  };
}

module.exports = {
  createBackup,
  ensureDirectory,
  listBackups,
  pruneOldBackups,
  resolveBackupFile,
  resolveBackupConfig,
  restoreBackupIntoDatabase,
  verifySqliteFile,
};
