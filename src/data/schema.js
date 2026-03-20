const schema = `
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS system_state (
  guild_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (guild_id, key)
);

CREATE TABLE IF NOT EXISTS players (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  username TEXT NOT NULL,
  display_name TEXT NOT NULL,
  role TEXT DEFAULT NULL,
  elo INTEGER NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  matches_played INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_win_streak INTEGER NOT NULL DEFAULT 0,
  last_result TEXT DEFAULT NULL,
  steam_id_64 TEXT DEFAULT NULL,
  steam_account_id INTEGER DEFAULT NULL,
  steam_profile_name TEXT DEFAULT NULL,
  steam_profile_url TEXT DEFAULT NULL,
  steam_last_synced_at TEXT DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS parties (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  leader_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS party_members (
  party_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  joined_at TEXT NOT NULL,
  PRIMARY KEY (party_id, user_id),
  UNIQUE (guild_id, user_id),
  FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS party_invites (
  party_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  invited_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (party_id, user_id),
  FOREIGN KEY (party_id) REFERENCES parties(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS queue_entries (
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  joined_at TEXT NOT NULL,
  queued_by TEXT NOT NULL,
  party_id TEXT DEFAULT NULL,
  PRIMARY KEY (guild_id, user_id)
);

CREATE TABLE IF NOT EXISTS matches (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  match_number INTEGER NOT NULL,
  series_id TEXT DEFAULT NULL,
  series_game_number INTEGER DEFAULT NULL,
  series_side_swap INTEGER NOT NULL DEFAULT 0,
  series_winner_slot TEXT DEFAULT NULL,
  status TEXT NOT NULL,
  source_channel_id TEXT NOT NULL,
  ready_check_message_id TEXT DEFAULT NULL,
  ready_deadline TEXT DEFAULT NULL,
  category_channel_id TEXT DEFAULT NULL,
  text_channel_id TEXT DEFAULT NULL,
  radiant_voice_channel_id TEXT DEFAULT NULL,
  dire_voice_channel_id TEXT DEFAULT NULL,
  winning_team TEXT DEFAULT NULL,
  reported_by TEXT DEFAULT NULL,
  reported_at TEXT DEFAULT NULL,
  notes TEXT DEFAULT NULL,
  radiant_avg_elo INTEGER DEFAULT NULL,
  dire_avg_elo INTEGER DEFAULT NULL,
  radiant_expected REAL DEFAULT NULL,
  dire_expected REAL DEFAULT NULL,
  radiant_delta INTEGER DEFAULT NULL,
  dire_delta INTEGER DEFAULT NULL,
  radiant_captain_user_id TEXT DEFAULT NULL,
  dire_captain_user_id TEXT DEFAULT NULL,
  captain_assigned_at TEXT DEFAULT NULL,
  host_user_id TEXT DEFAULT NULL,
  host_assigned_at TEXT DEFAULT NULL,
  lobby_name TEXT DEFAULT NULL,
  lobby_password TEXT DEFAULT NULL,
  steam_lobby_status TEXT DEFAULT NULL,
  steam_lobby_created_at TEXT DEFAULT NULL,
  steam_lobby_error TEXT DEFAULT NULL,
  pending_winning_team TEXT DEFAULT NULL,
  pending_reported_by TEXT DEFAULT NULL,
  pending_reported_at TEXT DEFAULT NULL,
  pending_reporter_team TEXT DEFAULT NULL,
  dota_match_id TEXT DEFAULT NULL,
  dota_radiant_win INTEGER DEFAULT NULL,
  dota_sides_flipped INTEGER DEFAULT NULL,
  dota_match_start_time INTEGER DEFAULT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, match_number)
);

CREATE TABLE IF NOT EXISTS series (
  id TEXT PRIMARY KEY,
  guild_id TEXT NOT NULL,
  series_number INTEGER NOT NULL,
  title TEXT NOT NULL,
  format TEXT NOT NULL,
  wins_to_clinch INTEGER NOT NULL,
  radiant_team_name TEXT NOT NULL,
  dire_team_name TEXT NOT NULL,
  radiant_score INTEGER NOT NULL DEFAULT 0,
  dire_score INTEGER NOT NULL DEFAULT 0,
  radiant_player_ids TEXT NOT NULL,
  dire_player_ids TEXT NOT NULL,
  radiant_role_map TEXT NOT NULL,
  dire_role_map TEXT NOT NULL,
  radiant_captain_user_id TEXT DEFAULT NULL,
  dire_captain_user_id TEXT DEFAULT NULL,
  next_game_side_swap INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (guild_id, series_number)
);

CREATE TABLE IF NOT EXISTS match_players (
  match_id TEXT NOT NULL,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  queue_order INTEGER NOT NULL,
  team TEXT DEFAULT NULL,
  preferred_role TEXT DEFAULT NULL,
  assigned_role TEXT DEFAULT NULL,
  party_id TEXT DEFAULT NULL,
  ready_status TEXT NOT NULL DEFAULT 'pending',
  ready_at TEXT DEFAULT NULL,
  elo_before INTEGER NOT NULL,
  elo_after INTEGER DEFAULT NULL,
  elo_delta INTEGER DEFAULT NULL,
  result TEXT DEFAULT NULL,
  PRIMARY KEY (match_id, user_id),
  FOREIGN KEY (match_id) REFERENCES matches(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS queue_panels (
  guild_id TEXT PRIMARY KEY,
  channel_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS rating_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  guild_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  old_elo INTEGER NOT NULL,
  new_elo INTEGER NOT NULL,
  reason TEXT DEFAULT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_queue_entries_guild_position ON queue_entries (guild_id, position);
CREATE INDEX IF NOT EXISTS idx_matches_guild_status ON matches (guild_id, status, created_at);
CREATE INDEX IF NOT EXISTS idx_match_players_guild_user ON match_players (guild_id, user_id, match_id);
CREATE INDEX IF NOT EXISTS idx_party_invites_guild_user ON party_invites (guild_id, user_id);
CREATE INDEX IF NOT EXISTS idx_rating_adjustments_guild_created ON rating_adjustments (guild_id, created_at);
CREATE INDEX IF NOT EXISTS idx_series_guild_status ON series (guild_id, status, created_at);
`;

module.exports = {
  schema,
};
