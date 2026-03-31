const fs = require('fs/promises');
const path = require('path');

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

const { schema } = require('./schema');

const COLUMN_MIGRATIONS = [
  {
    table: 'players',
    columns: [
      ['steam_id_64', 'TEXT DEFAULT NULL'],
      ['steam_account_id', 'INTEGER DEFAULT NULL'],
      ['steam_profile_name', 'TEXT DEFAULT NULL'],
      ['steam_profile_url', 'TEXT DEFAULT NULL'],
      ['steam_last_synced_at', 'TEXT DEFAULT NULL'],
    ],
  },
  {
    table: 'matches',
    columns: [
      ['series_id', 'TEXT DEFAULT NULL'],
      ['series_game_number', 'INTEGER DEFAULT NULL'],
      ['series_side_swap', 'INTEGER NOT NULL DEFAULT 0'],
      ['series_winner_slot', 'TEXT DEFAULT NULL'],
      ['radiant_captain_user_id', 'TEXT DEFAULT NULL'],
      ['dire_captain_user_id', 'TEXT DEFAULT NULL'],
      ['captain_assigned_at', 'TEXT DEFAULT NULL'],
      ['host_user_id', 'TEXT DEFAULT NULL'],
      ['host_assigned_at', 'TEXT DEFAULT NULL'],
      ['lobby_name', 'TEXT DEFAULT NULL'],
      ['lobby_password', 'TEXT DEFAULT NULL'],
      ['steam_lobby_status', 'TEXT DEFAULT NULL'],
      ['steam_lobby_created_at', 'TEXT DEFAULT NULL'],
      ['steam_lobby_error', 'TEXT DEFAULT NULL'],
      ['pending_winning_team', 'TEXT DEFAULT NULL'],
      ['pending_reported_by', 'TEXT DEFAULT NULL'],
      ['pending_reported_at', 'TEXT DEFAULT NULL'],
      ['pending_reporter_team', 'TEXT DEFAULT NULL'],
      ['dota_match_id', 'TEXT DEFAULT NULL'],
      ['dota_radiant_win', 'INTEGER DEFAULT NULL'],
      ['dota_sides_flipped', 'INTEGER DEFAULT NULL'],
      ['dota_match_start_time', 'INTEGER DEFAULT NULL'],
    ],
  },
  {
    table: 'series',
    columns: [
      ['next_game_side_swap', 'INTEGER NOT NULL DEFAULT 0'],
    ],
  },
];

async function applyMigrations(db) {
  for (const migration of COLUMN_MIGRATIONS) {
    const existingColumns = await db.all(`PRAGMA table_info(${migration.table})`);
    const existingNames = new Set(existingColumns.map((column) => column.name));

    for (const [columnName, definition] of migration.columns) {
      if (existingNames.has(columnName)) {
        continue;
      }

      await db.exec(`ALTER TABLE ${migration.table} ADD COLUMN ${columnName} ${definition}`);
    }
  }

  await db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_players_guild_steam_account ON players (guild_id, steam_account_id) WHERE steam_account_id IS NOT NULL',
  );
  await db.exec('CREATE INDEX IF NOT EXISTS idx_matches_guild_dota_match ON matches (guild_id, dota_match_id)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_matches_guild_series ON matches (guild_id, series_id, series_game_number)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_series_guild_status ON series (guild_id, status, created_at)');
  await db.exec('CREATE INDEX IF NOT EXISTS idx_admin_audit_log_guild_created ON admin_audit_log (guild_id, created_at DESC)');
}

async function createDatabase(filePath) {
  const resolvedPath = path.resolve(filePath);

  await fs.mkdir(path.dirname(resolvedPath), { recursive: true });

  const db = await open({
    filename: resolvedPath,
    driver: sqlite3.Database,
  });

  await db.exec('PRAGMA foreign_keys = ON;');
  await db.exec('PRAGMA journal_mode = WAL;');
  await db.exec(schema);
  await applyMigrations(db);

  async function transaction(handler) {
    await db.exec('BEGIN IMMEDIATE;');

    try {
      const result = await handler(db);
      await db.exec('COMMIT;');
      return result;
    } catch (error) {
      await db.exec('ROLLBACK;');
      throw error;
    }
  }

  return {
    db,
    transaction,
    get: (...args) => db.get(...args),
    all: (...args) => db.all(...args),
    run: (...args) => db.run(...args),
    exec: (...args) => db.exec(...args),
    close: () => db.close(),
  };
}

module.exports = {
  createDatabase,
};
