const { EventEmitter } = require('events');
const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');

const protobuf = require('protobufjs');
const SteamTotp = require('steam-totp');
const SteamUser = require('steam-user');
const { Dota2User, ServerRegion, SeriesType } = require('dota2-user');
const gcProtobufs = require('dota2-user/protobufs');
const gcMappings = require('dota2-user/protobufs/protobuf-mappings');

const GAME_MODE_MAP = {
  all_pick: 1,
  captains_mode: 2,
  single_draft: 4,
};

const TV_DELAY_MAP = {
  10: 0,
  120: 1,
  300: 2,
  900: 3,
};

const PAUSE_SETTING_MAP = {
  unlimited: 0,
  limited: 1,
  disabled: 2,
};

const REGION_MAP = {
  us_west: ServerRegion.USWest,
  us_east: ServerRegion.USEast,
  europe: ServerRegion.Europe,
  eu_east: ServerRegion.Austria,
  stockholm: ServerRegion.Stockholm,
  singapore: ServerRegion.Singapore,
  dubai: ServerRegion.Dubai,
  india: ServerRegion.India,
  japan: ServerRegion.Japan,
  australia: ServerRegion.Australia,
  south_africa: ServerRegion.SouthAfrica,
  brazil: ServerRegion.Brazil,
  peru: ServerRegion.Peru,
  chile: ServerRegion.Chile,
  argentina: ServerRegion.Argentina,
};

class DotaGcLobbyService extends EventEmitter {
  constructor(config, logger) {
    super();
    this.config = config;
    this.logger = logger;
    this.gcReady = false;
    this.currentLobbyMatchId = null;
    this.clientVersion = 0;
    this.protoRoot = null;
    this.steamUser = null;
    this.dota = null;
    this.pendingCreatePromise = null;
    this.pendingLaunchPromise = null;
  }

  debug(message) {
    if (this.config.steamLobbyDebug && this.logger && typeof this.logger.debug === 'function') {
      this.logger.debug(message);
    }
  }

  isEnabled() {
    return (
      this.config.steamAutoLobbyEnabled &&
      Boolean(this.config.steamAccountName) &&
      Boolean(this.config.steamPassword)
    );
  }

  isReady() {
    return this.gcReady && Boolean(this.steamUser) && Boolean(this.dota);
  }

  async start() {
    if (!this.isEnabled()) {
      await this.logger.info('Steam GC auto-lobby disabled. Set Steam credentials in .env to enable it.');
      return;
    }

    await fs.promises.mkdir(path.resolve(process.cwd(), this.config.steamDataDirectory), { recursive: true });

    this.protoRoot = this.loadLobbyProtoRoot();
    this.steamUser = new SteamUser({
      dataDirectory: path.resolve(process.cwd(), this.config.steamDataDirectory),
    });
    this.dota = new Dota2User(this.steamUser);

    this.registerHandlers();

    this.steamUser.logOn({
      accountName: this.config.steamAccountName,
      password: this.config.steamPassword,
      ...(this.config.steamSharedSecret
        ? { twoFactorCode: SteamTotp.generateAuthCode(this.config.steamSharedSecret) }
        : {}),
      rememberPassword: true,
    });
  }

  registerHandlers() {
    this.steamUser.on('steamGuard', async (domain, callback) => {
      if (this.config.steamSharedSecret && !domain) {
        callback(SteamTotp.generateAuthCode(this.config.steamSharedSecret));
        return;
      }

      try {
        const promptLabel = domain
          ? `Enter the Steam Guard code sent to your email (${domain}): `
          : 'Enter the Steam Guard code from your Steam app/email: ';
        const code = await this.promptForSteamGuardCode(promptLabel);
        callback(code);
      } catch (error) {
        await this.logger.error('Failed to read Steam Guard code from terminal.', error);
        callback('');
      }
    });

    this.steamUser.on('loggedOn', async () => {
      await this.logger.info(`Steam logged in as ${this.config.steamAccountName}. Launching Dota 2 GC session.`);
      this.steamUser.setPersona(SteamUser.EPersonaState.Online);
      this.steamUser.gamesPlayed(Dota2User.STEAM_APPID);
    });

    // Intercept the raw GC Welcome message to capture the Dota 2 client version.
    // dota2-user does not expose this, so we listen to the raw receivedFromGC event.
    this.steamUser.on('receivedFromGC', (appid, msgType, payload) => {
      if (appid !== Dota2User.STEAM_APPID) return;
      // k_EMsgGCClientWelcome = 4004
      if (msgType === gcProtobufs.EGCBaseClientMsg.k_EMsgGCClientWelcome) {
        try {
          const welcome = gcMappings.AllProtobufs[msgType];
          if (welcome) {
            const msg = welcome.decode(payload);
            if (msg.version && msg.version > 0) {
              this.clientVersion = msg.version;
              this.debug(`Captured Dota 2 client version from GC Welcome: ${this.clientVersion}`);
            }
          }
        } catch (err) {
          // best-effort; ignore
        }
      }
    });

    this.steamUser.on('accountLimitations', async (limited, communityBanned, locked, canInviteFriends) => {
      await this.logger.info(
        `Steam account limitations - limited=${limited}, communityBanned=${communityBanned}, locked=${locked}, canInviteFriends=${canInviteFriends}`,
      );
    });

    this.steamUser.on('error', async (error) => {
      this.gcReady = false;
      this.currentLobbyMatchId = null;
      await this.logger.error('Steam client error.', error);
    });

    this.steamUser.on('disconnected', async () => {
      this.gcReady = false;
      this.currentLobbyMatchId = null;
      await this.logger.warn('Steam client disconnected.');
    });

    this.dota.on('connectedToGC', async () => {
      this.gcReady = true;
      await this.logger.info('Connected to the Dota 2 Game Coordinator.');

      try {
        await this.clearStaleLobby();
      } catch (error) {
        await this.logger.warn('Could not clear a stale practice lobby on startup.', error);
      }

      this.emit('gcReady');
    });

    this.dota.on('disconnectedFromGC', async () => {
      this.gcReady = false;
      this.currentLobbyMatchId = null;
      await this.logger.warn('Disconnected from the Dota 2 Game Coordinator.');
    });
  }

  async promptForSteamGuardCode(promptLabel) {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    try {
      const code = await rl.question(promptLabel);
      return String(code || '').trim();
    } finally {
      rl.close();
    }
  }

  loadLobbyProtoRoot() {
    const root = new protobuf.Root();

    // Use a locally vendored practice-lobby proto based on the current live
    // GameTracking-Dota2 definitions. The bundled steam-resources copy in
    // node_modules is stale and is missing/has outdated lobby fields.
    root.loadSync(path.join(__dirname, 'dotaPracticeLobby.proto'));
    return root;
  }

  getServerRegion() {
    return REGION_MAP[this.config.steamLobbyRegion] || ServerRegion.Europe;
  }

  getGameMode() {
    return GAME_MODE_MAP[this.config.steamLobbyGameMode] || GAME_MODE_MAP.captains_mode;
  }

  getTvDelay() {
    return TV_DELAY_MAP[this.config.steamLobbyTvDelay] ?? TV_DELAY_MAP[120];
  }

  getPauseSetting() {
    return PAUSE_SETTING_MAP[this.config.steamLobbyPauseSetting] ?? PAUSE_SETTING_MAP.unlimited;
  }

  getSeriesType(series) {
    if (!series) {
      return SeriesType.NONE;
    }

    if (series.format === 'bo5') {
      return SeriesType.BEST_OF_FIVE;
    }

    return SeriesType.BEST_OF_THREE;
  }

  buildLobbyDetails(match, series) {
    return {
      gameName: match.lobby_name || `Discord Match ${match.id}`,
      passKey: match.lobby_password || '',
      serverRegion: this.getServerRegion(),
      gameMode: this.getGameMode(),
      cmPick: 0,
      allowCheats: false,
      fillWithBots: false,
      botDifficultyRadiant: 0,
      botDifficultyDire: 0,
      botRadiant: 0,
      botDire: 0,
      allowSpectating: this.config.steamLobbyAllowSpectating,
      seriesType: this.getSeriesType(series),
      radiantSeriesWins: series ? series.radiant_score : 0,
      direSeriesWins: series ? series.dire_score : 0,
      previousMatchOverride: 0,
      allchat: this.config.steamLobbyAllChat,
      dotaTvDelay: this.getTvDelay(),
      leagueid: 0,
      customGameMode: '',
      customMapName: '',
      customDifficulty: 0,
      customGameId: 0,
      customGameCrc: 0,
      customMinPlayers: 0,
      customMaxPlayers: 0,
      visibility: 0,
      pauseSetting: this.getPauseSetting(),
      selectionPriorityRules: 0,
    };
  }

  /**
   * Decode a k_EMsgGCPracticeLobbyResponse payload (message id 7055).
   * The GC sends this as a simple message with an optional int32 eresult field (field 1).
   * We manually decode the first varint to get the eresult value.
   * Returns { eresult } where eresult=1 means OK (EResult.k_EResultOK).
   */
  decodePracticeLobbyResponse(payload) {
    if (!payload || payload.length === 0) {
      // Empty payload — treat as success (GC acknowledged with no error)
      return { eresult: 1 };
    }
    try {
      const reader = protobuf.Reader.create(payload);
      const result = { eresult: 1 };
      while (reader.pos < reader.len) {
        const tag = reader.uint32();
        const fieldId = tag >>> 3;
        const wireType = tag & 0x7;
        if (fieldId === 1 && wireType === 0) {
          result.eresult = reader.int32();
        } else {
          reader.skipType(wireType);
        }
      }
      return result;
    } catch (err) {
      return { eresult: 1 };
    }
  }

  sendLobbyGcMessage(messageId, payload, callback) {
    const protoHeader = {
      steamid: this.steamUser && this.steamUser.steamID ? this.steamUser.steamID.getSteamID64() : '0',
      client_sessionid: this.steamUser && Number.isInteger(this.steamUser._sessionID) ? this.steamUser._sessionID : 0,
      routing_appid: Dota2User.STEAM_APPID,
    };

    this.steamUser.sendToGC(Dota2User.STEAM_APPID, messageId, protoHeader, payload, callback);
  }

  async clearStaleLobby() {
    if (!this.isReady()) {
      return;
    }

    try {
      // Fire-and-forget: k_EMsgGCPracticeLobbyLeave has no job-based response.
      // Give the GC a short moment to process the leave before proceeding.
      this.dota.sendRawBuffer(gcProtobufs.EDOTAGCMsg.k_EMsgGCPracticeLobbyLeave, Buffer.alloc(0));
      await new Promise((resolve) => setTimeout(resolve, 1000));
    } catch (error) {
      // Ignore errors - this is best-effort cleanup
        this.debug(`Clear stale lobby attempt failed (expected): ${error && error.message}`);
    }
  }

  async resetGcState() {
    if (!this.isReady()) {
      return;
    }

    const { EDOTAGCMsg, EGCBaseMsg } = gcProtobufs;

    const cleanupSteps = [
      { label: 'leave practice lobby', messageId: EDOTAGCMsg.k_EMsgGCPracticeLobbyLeave, payload: Buffer.alloc(0) },
      { label: 'destroy lobby', messageId: EDOTAGCMsg.k_EMsgDestroyLobbyRequest, payload: Buffer.alloc(0) },
      { label: 'abandon current game', messageId: EDOTAGCMsg.k_EMsgGCAbandonCurrentGame, payload: Buffer.alloc(0) },
      { label: 'leave party', messageId: EGCBaseMsg.k_EMsgGCLeaveParty, payload: Buffer.alloc(0) },
    ];

    for (const step of cleanupSteps) {
      try {
        this.debug(`GC reset: sending ${step.label} (${step.messageId})`);
        this.sendLobbyGcMessage(step.messageId, step.payload);
      } catch (error) {
        this.debug(`GC reset step failed for ${step.label}: ${error && error.message ? error.message : error}`);
      }

      await new Promise((resolve) => setTimeout(resolve, 800));
    }

    this.currentLobbyMatchId = null;
    await new Promise((resolve) => setTimeout(resolve, 1200));
  }

  async createLobby(match, series) {
    if (this.pendingCreatePromise) {
      this.debug('createLobby deduped: returning existing in-flight create request.');
      return this.pendingCreatePromise;
    }

    const requestPromise = this.createLobbyInternal(match, series);
    this.pendingCreatePromise = requestPromise;

    try {
      return await requestPromise;
    } finally {
      if (this.pendingCreatePromise === requestPromise) {
        this.pendingCreatePromise = null;
      }
    }
  }

  async createLobbyInternal(match, series) {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled' };
    }

    if (!this.isReady()) {
      return { ok: false, reason: 'not_ready' };
    }

    if (this.currentLobbyMatchId === match.id) {
      return { ok: true, reason: 'already_created' };
    }

    if (this.currentLobbyMatchId && this.currentLobbyMatchId !== match.id) {
      return {
        ok: false,
        reason: 'busy',
        activeMatchId: this.currentLobbyMatchId,
      };
    }

    await this.resetGcState();

    const detailsObj = this.buildLobbyDetails(match, series);

    const CMsgPracticeLobbyCreate = this.protoRoot.lookupType('CMsgPracticeLobbyCreate');
    const createPayload = CMsgPracticeLobbyCreate.create({
      searchKey: match.lobby_search_key || '',
      passKey: match.lobby_password || '',
      clientVersion: this.clientVersion,
      lobbyDetails: detailsObj,
    });
    const createBuffer = Buffer.from(CMsgPracticeLobbyCreate.encode(createPayload).finish());

    const { EDOTAGCMsg, DOTAJoinLobbyResult } = gcProtobufs;

    // Build a reverse-lookup map of EDOTAGCMsg values for debug logging
    const msgIdToName = {};
    for (const [name, val] of Object.entries(EDOTAGCMsg)) {
      if (typeof val === 'number') msgIdToName[val] = name;
    }

    this.debug(`Creating lobby: gameName=${detailsObj.gameName} region=${detailsObj.serverRegion} mode=${detailsObj.gameMode} clientVersion=${this.clientVersion} bufLen=${createBuffer.length}`);
    this.debug(`Outgoing createBuffer hex: ${createBuffer.toString('hex')}`);

    // Use the callback approach so steam-user assigns a jobid_source and the GC
    // routes the reply back through the job callback (NOT via receivedFromGC).
    // We ALSO install a receivedFromGC snoop to catch any broadcast messages
    // the GC sends in parallel (e.g. a lobby-update broadcast after creation).
    return new Promise((resolve) => {
      let settled = false;

      // Fallback timeout in case the GC never calls back
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.steamUser.removeListener('receivedFromGC', onBroadcast);
        resolve({ ok: false, reason: 'gc_rejected', result: 'timeout' });
      }, 20000);

      // Snoop for any GC broadcasts that arrive alongside the job callback
      const onBroadcast = (appid, msgType, payload) => {
        if (appid !== Dota2User.STEAM_APPID) return;
        const name = msgIdToName[msgType] || 'UNKNOWN';
        this.debug(`[CREATE SNOOP] broadcast msgType=${msgType} (${name}) payloadBytes=${payload ? payload.length : 0} hex=${payload ? payload.slice(0, 16).toString('hex') : 'null'}`);
      };
      this.steamUser.on('receivedFromGC', onBroadcast);

      try {
        this.sendLobbyGcMessage(EDOTAGCMsg.k_EMsgGCPracticeLobbyCreate, createBuffer, async (_appid, responseMessageId, responsePayload) => {
          if (settled) return;
          clearTimeout(timeout);
          settled = true;
          this.steamUser.removeListener('receivedFromGC', onBroadcast);

          // --- Diagnostic logging ---
          const msgName = msgIdToName[responseMessageId] || 'UNKNOWN';
          const payloadHex = responsePayload ? responsePayload.toString('hex') : 'null';
          this.debug(`createLobby callback: responseMessageId=${responseMessageId} (${msgName}) payloadBytes=${responsePayload ? responsePayload.length : 0}`);
          this.debug(`createLobby response hex: ${payloadHex}`);

          try {
            if (responseMessageId === EDOTAGCMsg.k_EMsgGCPracticeLobbyJoinResponse) {
              // GC replied with a join response — lobby was created and we auto-joined it
              const CMsgPracticeLobbyJoinResponse = this.protoRoot.lookupType('CMsgPracticeLobbyJoinResponse');
              const joinResponse = CMsgPracticeLobbyJoinResponse.decode(responsePayload);
              this.debug(`createLobby JoinResponse.result=${joinResponse.result}`);
              const success =
                joinResponse.result === 0 ||
                joinResponse.result === DOTAJoinLobbyResult.DOTA_JOIN_RESULT_SUCCESS;
              if (success) {
                this.currentLobbyMatchId = match.id;
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
                resolve({ ok: true, reason: 'created' });
              } else {
                resolve({ ok: false, reason: 'gc_rejected', result: joinResponse.result });
              }
            } else {
              // Generic response (k_EMsgGCPracticeLobbyResponse = 7055, or anything else)
              const genericResponse = this.decodePracticeLobbyResponse(responsePayload);
              this.debug(`createLobby PracticeLobbyResponse.eresult=${genericResponse.eresult}`);
              if (genericResponse.eresult === 1) {
                this.currentLobbyMatchId = match.id;
                await new Promise((resolveDelay) => setTimeout(resolveDelay, 1500));
                resolve({ ok: true, reason: 'created' });
              } else {
                resolve({ ok: false, reason: 'gc_rejected', result: genericResponse.eresult });
              }
            }
          } catch (err) {
            if (this.logger && typeof this.logger.error === 'function') {
              this.logger.error('Failed to decode createLobby response.', err);
            }
            resolve({ ok: false, reason: 'gc_rejected', result: err && err.message ? err.message : 'decode_error' });
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        settled = true;
        this.steamUser.removeListener('receivedFromGC', onBroadcast);
        resolve({
          ok: false,
          reason: 'send_error',
          result: error && error.message ? error.message : 'unknown',
        });
      }
    });
  }

  async launchLobby(matchId) {
    if (this.pendingLaunchPromise) {
      this.debug('launchLobby deduped: returning existing in-flight launch request.');
      return this.pendingLaunchPromise;
    }

    const requestPromise = this.launchLobbyInternal(matchId);
    this.pendingLaunchPromise = requestPromise;

    try {
      return await requestPromise;
    } finally {
      if (this.pendingLaunchPromise === requestPromise) {
        this.pendingLaunchPromise = null;
      }
    }
  }

  async launchLobbyInternal(matchId) {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled' };
    }

    if (!this.isReady()) {
      return { ok: false, reason: 'not_ready' };
    }

    if (this.currentLobbyMatchId !== matchId) {
      return { ok: false, reason: 'not_active' };
    }

    const { EDOTAGCMsg } = gcProtobufs;
    const CMsgPracticeLobbyLaunch = this.protoRoot.lookupType('CMsgPracticeLobbyLaunch');
    const launchPayload = CMsgPracticeLobbyLaunch.create({
      clientVersion: this.clientVersion,
    });
    const launchBuffer = Buffer.from(CMsgPracticeLobbyLaunch.encode(launchPayload).finish());

    // Build a reverse-lookup map of EDOTAGCMsg values for debug logging
    const msgIdToName = {};
    for (const [name, val] of Object.entries(EDOTAGCMsg)) {
      if (typeof val === 'number') msgIdToName[val] = name;
    }

    // Use the callback approach so the GC routes the reply back via the job callback.
    return new Promise((resolve) => {
      let settled = false;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ ok: false, reason: 'gc_rejected', result: 'timeout' });
      }, 15000);

      try {
        this.debug(`Launching lobby with clientVersion=${this.clientVersion} bufLen=${launchBuffer.length}`);
        this.debug(`Outgoing launchBuffer hex: ${launchBuffer.toString('hex')}`);

        this.sendLobbyGcMessage(EDOTAGCMsg.k_EMsgGCPracticeLobbyLaunch, launchBuffer, (_appid, responseMessageId, responsePayload) => {
          if (settled) return;
          clearTimeout(timeout);
          settled = true;

          // --- Diagnostic logging ---
          const msgName = msgIdToName[responseMessageId] || 'UNKNOWN';
          const payloadHex = responsePayload ? responsePayload.toString('hex') : 'null';
          this.debug(`launchLobby callback: responseMessageId=${responseMessageId} (${msgName}) payloadBytes=${responsePayload ? responsePayload.length : 0}`);
          this.debug(`launchLobby payload hex: ${payloadHex}`);

          try {
            const genericResponse = this.decodePracticeLobbyResponse(responsePayload);
            this.debug(`launchLobby PracticeLobbyResponse.eresult=${genericResponse.eresult}`);
            if (genericResponse.eresult === 1) {
              resolve({ ok: true, reason: 'launched' });
            } else {
              resolve({ ok: false, reason: 'gc_rejected', result: genericResponse.eresult });
            }
          } catch (err) {
            if (this.logger && typeof this.logger.error === 'function') {
              this.logger.error('Failed to decode launchLobby response.', err);
            }
            resolve({ ok: false, reason: 'gc_rejected', result: err && err.message ? err.message : 'decode_error' });
          }
        });
      } catch (error) {
        clearTimeout(timeout);
        settled = true;
        resolve({
          ok: false,
          reason: 'send_error',
          result: error && error.message ? error.message : 'unknown',
        });
      }
    });
  }

  async closeLobby(matchId) {
    if (!this.isEnabled()) {
      return { ok: false, reason: 'disabled' };
    }

    if (!this.isReady()) {
      this.currentLobbyMatchId = null;
      return { ok: false, reason: 'not_ready' };
    }

    if (this.currentLobbyMatchId && this.currentLobbyMatchId !== matchId) {
      return { ok: false, reason: 'different_active_match', activeMatchId: this.currentLobbyMatchId };
    }

    await this.resetGcState();
    await new Promise((resolve) => setTimeout(resolve, 1500));

    this.currentLobbyMatchId = null;

    return {
      ok: true,
      reason: 'closed',
    };
  }
}

module.exports = {
  DotaGcLobbyService,
};
