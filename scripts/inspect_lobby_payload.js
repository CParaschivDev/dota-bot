// Quick helper to reproduce the reference lobby_details produced by node_modules/dota2
const Dota2 = require('dota2');

const defaults = {
  game_name: '',
  server_region: Dota2.ServerRegion.UNSPECIFIED,
  game_mode: Dota2.schema.DOTA_GameMode.DOTA_GAMEMODE_AP,
  game_version: Dota2.schema.DOTAGameVersion.GAME_VERSION_STABLE,
  cm_pick: Dota2.schema.DOTA_CM_PICK.DOTA_CM_RANDOM,
  allow_cheats: false,
  fill_with_bots: false,
  bot_difficulty_radiant: Dota2.schema.DOTABotDifficulty.BOT_DIFFICULTY_PASSIVE,
  bot_difficulty_dire: Dota2.schema.DOTABotDifficulty.BOT_DIFFICULTY_PASSIVE,
  allow_spectating: true,
  pass_key: '',
  series_type: Dota2.SeriesType.NONE,
  radiant_series_wins: 0,
  dire_series_wins: 0,
  allchat: false,
  dota_tv_delay: Dota2.schema.LobbyDotaTVDelay.LobbyDotaTV_120,
  leagueid: 0,
  previous_match_override: 0,
  custom_game_mode: '',
  custom_map_name: '',
  custom_difficulty: 0,
  custom_game_id: 0,
  custom_game_crc: 0,
};

const options = {
  game_name: 'Discord Match 42',
  pass_key: 'supersecret',
};

const finalOptions = Object.assign(defaults, options);

const lobby_details = Dota2._parseOptions(finalOptions, Dota2._lobbyOptions);

console.log('reference lobby_details:');
console.log(JSON.stringify(lobby_details, null, 2));

const payload = { lobby_details, pass_key: finalOptions.pass_key };
console.log('\nreference payload:');
console.log(JSON.stringify(payload, null, 2));

// Keep exit code 0
process.exit(0);
