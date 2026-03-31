require('dotenv').config();

const { resolveBackupConfig, restoreBackupIntoDatabase } = require('../src/utils/databaseBackup');
const { createDatabase } = require('../src/data/database');

async function main() {
  const backupFileArg = process.argv[2];

  if (!backupFileArg) {
    throw new Error('Usage: node scripts/restore-db.js <backup-file.sqlite>');
  }

  const backupConfig = resolveBackupConfig(process.env, process.cwd());
  const database = await createDatabase(backupConfig.databasePath);

  try {
    const result = await restoreBackupIntoDatabase({
      database,
      databasePath: backupConfig.databasePath,
      backupDirectory: backupConfig.backupDirectory,
      retentionCount: backupConfig.retentionCount,
      backupFileName: backupFileArg,
    });

    console.log(`Created safety copy at ${result.safetyCopy.destination}`);
    console.log(`Database restored from ${result.restoredPath}`);
  } finally {
    await database.close();
  }
}

main().catch((error) => {
  console.error('Failed to restore database.', error);
  process.exit(1);
});
