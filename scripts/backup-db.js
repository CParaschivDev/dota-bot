require('dotenv').config();

const { createBackup, resolveBackupConfig } = require('../src/utils/databaseBackup');

async function main() {
  const backupConfig = resolveBackupConfig(process.env, process.cwd());
  const result = await createBackup({
    databasePath: backupConfig.databasePath,
    backupDirectory: backupConfig.backupDirectory,
    retentionCount: backupConfig.retentionCount,
    prefix: 'dota-bot',
  });

  console.log(`Database backup created at ${result.destination}`);

  if (result.prunedFiles.length) {
    console.log(`Pruned ${result.prunedFiles.length} old backup(s).`);
  }
}

main().catch((error) => {
  console.error('Failed to create database backup.', error);
  process.exit(1);
});
