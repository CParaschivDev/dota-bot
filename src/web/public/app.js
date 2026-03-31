(function () {
  const STORAGE_KEYS = {
    token: 'dota-web-admin-token',
    actorId: 'dota-web-admin-actor-id',
  };

  const state = {
    guildId: null,
    meta: null,
    refreshTimer: null,
    liveSource: null,
    adminToken: window.localStorage.getItem(STORAGE_KEYS.token) || '',
    adminActorId: window.localStorage.getItem(STORAGE_KEYS.actorId) || '',
    auth: {
      oauthEnabled: false,
      authenticated: false,
      user: null,
      guilds: [],
      selectedGuild: null,
      canAdminCurrentGuild: false,
      guildAllowedByConfig: true,
      loginUrl: '/auth/discord/login',
      logoutUrl: '/auth/discord/logout',
    },
    selectedMatchId: null,
    selectedPlayerId: null,
    auditEntries: [],
    backups: [],
  };

  const initialUrl = new URL(window.location.href);
  state.guildId = initialUrl.searchParams.get('guildId');

  const elements = {
    pageTitle: document.getElementById('page-title'),
    guildSelect: document.getElementById('guild-select'),
    lastRefresh: document.getElementById('last-refresh'),
    summaryCards: document.getElementById('summary-cards'),
    summaryExtra: document.getElementById('summary-extra'),
    queueList: document.getElementById('queue-list'),
    leaderboardList: document.getElementById('leaderboard-list'),
    matchesList: document.getElementById('matches-list'),
    detailsTitle: document.getElementById('details-title'),
    detailsBody: document.getElementById('details-body'),
    auditLog: document.getElementById('audit-log'),
    summaryCardTemplate: document.getElementById('summary-card-template'),
    adminToken: document.getElementById('admin-token'),
    adminActorId: document.getElementById('admin-actor-id'),
    adminSave: document.getElementById('admin-save'),
    adminMatchForm: document.getElementById('admin-match-form'),
    adminPlayerForm: document.getElementById('admin-player-form'),
    adminSystemForm: document.getElementById('admin-system-form'),
    adminStatus: document.getElementById('admin-status'),
    adminMode: document.getElementById('admin-mode'),
    adminTokenField: document.getElementById('admin-token-field'),
    adminActorField: document.getElementById('admin-actor-field'),
    backupList: document.getElementById('backup-list'),
    authStatus: document.getElementById('auth-status'),
    authLogin: document.getElementById('auth-login'),
    authLogout: document.getElementById('auth-logout'),
    exportAuditJson: document.getElementById('export-audit-json'),
    exportAuditCsv: document.getElementById('export-audit-csv'),
  };

  function escapeHtml(value) {
    return String(value == null ? '' : value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#39;');
  }

  function formatDate(value) {
    if (!value) {
      return 'n/a';
    }

    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ro-RO');
  }

  function formatTimestampSeconds(value) {
    if (!value) {
      return 'n/a';
    }

    return formatDate(new Date(Number(value) * 1000).toISOString());
  }

  function formatRole(role) {
    const labels = {
      carry: 'Carry',
      mid: 'Mid',
      offlane: 'Offlane',
      support: 'Support',
    };

    return labels[role] || 'Unassigned';
  }

  function formatResult(result) {
    if (!result) {
      return 'pending';
    }

    return result === 'win' ? 'victorie' : result === 'loss' ? 'infrangere' : result;
  }

  function formatStatus(status) {
    return String(status || '')
      .replaceAll('_', ' ')
      .toLowerCase();
  }

  async function fetchJson(path, options) {
    const response = await fetch(path, options || { headers: { Accept: 'application/json' }, credentials: 'same-origin' });
    const payload = await response.json();

    if (!response.ok) {
      throw new Error(payload.error || 'Cererea a esuat.');
    }

    return payload;
  }

  function buildApiPath(basePath) {
    if (!state.guildId) {
      return basePath;
    }

    const separator = basePath.includes('?') ? '&' : '?';
    return `${basePath}${separator}guildId=${encodeURIComponent(state.guildId)}`;
  }

  function syncGuildQueryParam() {
    const url = new URL(window.location.href);

    if (state.guildId) {
      url.searchParams.set('guildId', state.guildId);
    } else {
      url.searchParams.delete('guildId');
    }

    window.history.replaceState({}, '', url.toString());
  }

  function setEmptyState(container, message) {
    container.classList.add('empty-state');
    container.innerHTML = '';
    container.textContent = message;
  }

  function clearEmptyState(container) {
    container.classList.remove('empty-state');
    container.textContent = '';
  }

  function setAdminStatus(message, tone) {
    elements.adminStatus.className = `admin-status ${tone || 'ready'}`;
    elements.adminStatus.textContent = message;
  }

  function canReadAdminData() {
    return (
      (state.auth.oauthEnabled && state.auth.authenticated && state.auth.canAdminCurrentGuild) ||
      Boolean(state.adminToken)
    );
  }

  function getAdminRequestHeaders(extraHeaders) {
    const headers = {
      ...(extraHeaders || {}),
    };

    if (state.adminToken && !(state.auth.oauthEnabled && state.auth.authenticated && state.auth.canAdminCurrentGuild)) {
      headers.Authorization = `Bearer ${state.adminToken}`;
    }

    return headers;
  }

  function saveAdminSession() {
    state.adminToken = elements.adminToken.value.trim();
    state.adminActorId = elements.adminActorId.value.trim();
    window.localStorage.setItem(STORAGE_KEYS.token, state.adminToken);
    window.localStorage.setItem(STORAGE_KEYS.actorId, state.adminActorId);
    renderAuthBox();
    loadBackups().catch(() => null);
    setAdminStatus(
      state.adminToken
        ? 'Sesiunea admin cu token este salvata local in browser.'
        : 'Token-ul a fost golit. Daca nu folosesti Discord OAuth, admin panel este dezactivat.',
      state.adminToken ? 'success' : 'ready',
    );
  }

  async function refreshAuthSession() {
    state.auth = await fetchJson(buildApiPath('/api/auth/session'));
  }

  function renderAuthBox() {
    const auth = state.auth;
    const returnTo = `${window.location.pathname}${window.location.search}`;
    const guildId = state.guildId || '';
    const loginUrl = new URL(auth.loginUrl || '/auth/discord/login', window.location.origin);
    loginUrl.searchParams.set('returnTo', returnTo);

    if (guildId) {
      loginUrl.searchParams.set('guildId', guildId);
    }

    const logoutUrl = new URL(auth.logoutUrl || '/auth/discord/logout', window.location.origin);
    logoutUrl.searchParams.set('returnTo', returnTo);

    elements.authLogin.href = `${loginUrl.pathname}${loginUrl.search}`;
    elements.authLogout.href = `${logoutUrl.pathname}${logoutUrl.search}`;

    if (auth.oauthEnabled) {
      if (auth.authenticated) {
        const guildLabel = auth.selectedGuild
          ? `${auth.selectedGuild.name} (${auth.canAdminCurrentGuild ? 'admin ok' : auth.guildAllowedByConfig ? 'fara manage' : 'blocat de config'})`
          : 'selecteaza un guild';
        elements.authStatus.innerHTML = `
          Conectat ca <strong>${escapeHtml(auth.user.globalName || auth.user.username || auth.user.id)}</strong><br />
          Guild curent: <strong>${escapeHtml(guildLabel)}</strong>
        `;
        elements.authLogin.style.display = 'none';
        elements.authLogout.style.display = 'inline-flex';
      } else {
        elements.authStatus.textContent = 'Autentifica-te cu Discord pentru admin panel pe baza permisiunilor tale din server.';
        elements.authLogin.style.display = 'inline-flex';
        elements.authLogout.style.display = 'none';
      }
    } else {
      elements.authStatus.textContent = 'Discord OAuth nu este configurat. Ramane disponibil doar token-ul manual pentru admin.';
      elements.authLogin.style.display = 'none';
      elements.authLogout.style.display = 'none';
    }

    if (auth.oauthEnabled) {
      elements.adminMode.textContent = auth.authenticated
        ? auth.canAdminCurrentGuild
          ? 'Mod admin Discord activ. Permisiunile tale din guild valideaza actiunile.'
          : auth.guildAllowedByConfig
            ? 'Esti conectat cu Discord, dar nu ai Manage Server/Admin pe guildul curent.'
            : 'Guildul curent nu este permis in WEB_ADMIN_ALLOWED_GUILD_IDS.'
        : 'Discord OAuth activ. Conecteaza-te cu Discord sau foloseste fallback-ul cu token manual.';
    } else {
      elements.adminMode.textContent = 'Mod admin clasic cu token manual.';
    }

    const showTokenFields = !auth.oauthEnabled || !auth.authenticated;
    elements.adminTokenField.style.display = showTokenFields ? 'grid' : 'none';
    elements.adminActorField.style.display = showTokenFields ? 'grid' : 'none';
    elements.adminSave.style.display = showTokenFields ? 'inline-flex' : 'none';
  }

  function renderMeta(meta) {
    state.meta = meta;
    document.title = meta.title;
    elements.pageTitle.textContent = meta.title;

    const selectedValue = state.guildId || meta.defaultGuildId || '';
    elements.guildSelect.innerHTML = '';

    meta.guilds.forEach((guild) => {
      const option = document.createElement('option');
      option.value = guild.guildId;
      option.textContent = `${guild.guildId} (${guild.playerCount} jucatori)`;

      if (guild.guildId === selectedValue) {
        option.selected = true;
      }

      elements.guildSelect.appendChild(option);
    });

    elements.guildSelect.disabled = meta.guilds.length === 0;

    if (!state.guildId && selectedValue) {
      state.guildId = selectedValue;
      syncGuildQueryParam();
    }
  }

  function renderSummary(summary) {
    clearEmptyState(elements.summaryCards);
    clearEmptyState(elements.summaryExtra);
    elements.summaryCards.innerHTML = '';
    elements.summaryExtra.innerHTML = '';

    if (!summary) {
      setEmptyState(elements.summaryCards, 'Nu exista inca date pentru guildul selectat.');
      return;
    }

    const cards = [
      { label: 'Jucatori', value: summary.players, meta: 'inscrisi in baza' },
      { label: 'Queue', value: summary.queueSize, meta: 'in asteptare acum' },
      { label: 'Open', value: summary.matches.open, meta: 'meciuri active' },
      { label: 'Ready Check', value: summary.matches.readyCheck, meta: 'verificari live' },
      { label: 'Reported', value: summary.matches.reported, meta: 'meciuri validate' },
    ];

    cards.forEach((card) => {
      const fragment = elements.summaryCardTemplate.content.cloneNode(true);
      fragment.querySelector('.summary-label').textContent = card.label;
      fragment.querySelector('.summary-value').textContent = card.value;
      fragment.querySelector('.summary-meta').textContent = card.meta;
      elements.summaryCards.appendChild(fragment);
    });

    const pills = [];

    if (summary.activeReadyCheck) {
      pills.push(`Ready check activ: ${summary.activeReadyCheck.id} pana la ${formatDate(summary.activeReadyCheck.readyDeadline)}`);
    }

    if (summary.latestMatches && summary.latestMatches.length) {
      pills.push(`Ultimul meci: ${summary.latestMatches[0].id} (${formatStatus(summary.latestMatches[0].status)})`);
    }

    if (!pills.length) {
      pills.push('Fara ready check activ momentan.');
    }

    pills.forEach((text) => {
      const pill = document.createElement('div');
      pill.className = 'pill';
      pill.textContent = text;
      elements.summaryExtra.appendChild(pill);
    });
  }

  function renderQueue(queue) {
    elements.queueList.innerHTML = '';

    if (!queue.length) {
      setEmptyState(elements.queueList, 'Queue gol.');
      return;
    }

    clearEmptyState(elements.queueList);

    queue.forEach((entry) => {
      const item = document.createElement('article');
      item.className = 'queue-entry';
      item.innerHTML = `
        <div>
          <div class="entry-title">#${entry.position} ${escapeHtml(entry.displayName || entry.username || entry.userId)}</div>
          <div class="entry-meta">${escapeHtml(formatRole(entry.role))} - ${escapeHtml(entry.elo)} ELO - intrat la ${escapeHtml(formatDate(entry.joinedAt))}</div>
        </div>
        <div class="queue-badge">${entry.partyId ? `${entry.partySize}-stack` : 'solo'}</div>
      `;
      elements.queueList.appendChild(item);
    });
  }

  function renderLeaderboard(leaderboard) {
    elements.leaderboardList.innerHTML = '';

    if (!leaderboard.length) {
      setEmptyState(elements.leaderboardList, 'Nu exista jucatori.');
      return;
    }

    clearEmptyState(elements.leaderboardList);

    leaderboard.forEach((player) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'leaderboard-entry';
      item.innerHTML = `
        <span class="leaderboard-rank">${player.rank}</span>
        <span>
          <span class="entry-title">${escapeHtml(player.displayName || player.username || player.userId)}</span>
          <span class="entry-meta">${escapeHtml(formatRole(player.role))} - ${player.wins}W/${player.losses}L - ${player.winRate}% win rate</span>
        </span>
        <span class="entry-value">${player.elo} ELO</span>
      `;
      item.addEventListener('click', () => loadPlayerDetails(player.userId));
      elements.leaderboardList.appendChild(item);
    });
  }

  function buildMatchTags(match) {
    const tags = [];
    tags.push(`<span class="tag">${escapeHtml(formatStatus(match.status))}</span>`);

    if (match.winningTeam) {
      tags.push(`<span class="tag warm">winner: ${escapeHtml(match.winningTeam)}</span>`);
    }

    if (match.dotaMatchId) {
      tags.push(`<span class="tag">STRATZ ${escapeHtml(match.dotaMatchId)}</span>`);
    }

    if (match.pendingWinningTeam) {
      tags.push(`<span class="tag danger">pending: ${escapeHtml(match.pendingWinningTeam)}</span>`);
    }

    return tags.join('');
  }

  function renderMatches(matches) {
    elements.matchesList.innerHTML = '';

    if (!matches.length) {
      setEmptyState(elements.matchesList, 'Nu exista meciuri.');
      return;
    }

    clearEmptyState(elements.matchesList);

    matches.forEach((match) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'match-entry';
      item.innerHTML = `
        <div class="match-top">
          <div class="entry-title">${escapeHtml(match.id)}</div>
          <div class="entry-meta">${escapeHtml(formatDate(match.createdAt))}</div>
        </div>
        <div class="match-stats">${buildMatchTags(match)}</div>
      `;
      item.addEventListener('click', () => loadMatchDetails(match.id));
      elements.matchesList.appendChild(item);
    });
  }

  function renderAuditLog(entries) {
    state.auditEntries = entries;
    elements.auditLog.innerHTML = '';

    if (!entries.length) {
      setEmptyState(elements.auditLog, 'Nu exista inca actiuni admin pentru guildul selectat.');
      return;
    }

    clearEmptyState(elements.auditLog);

    entries.forEach((entry) => {
      const item = document.createElement('article');
      item.className = 'audit-entry';
      const details = entry.details ? escapeHtml(JSON.stringify(entry.details, null, 2)) : '';
      item.innerHTML = `
        <div class="audit-top">
          <div class="audit-title">${escapeHtml(entry.action)} - ${escapeHtml(entry.status)}</div>
          <div class="audit-meta">${escapeHtml(formatDate(entry.createdAt))}</div>
        </div>
        <div class="audit-meta">actor: ${escapeHtml(entry.actorLabel || entry.actorId || 'n/a')} (${escapeHtml(entry.actorSource || 'unknown')})</div>
        <div class="audit-meta">target: ${escapeHtml(entry.targetType || 'n/a')} / ${escapeHtml(entry.targetId || 'n/a')}</div>
        ${entry.errorMessage ? `<div class="tag danger">${escapeHtml(entry.errorMessage)}</div>` : ''}
        ${details ? `<pre class="audit-json">${details}</pre>` : ''}
      `;
      elements.auditLog.appendChild(item);
    });
  }

  function renderBackupList(backups) {
    state.backups = backups;
    elements.backupList.innerHTML = '';

    if (!backups.length) {
      setEmptyState(elements.backupList, 'Nu exista backup-uri disponibile pentru restore.');
      return;
    }

    clearEmptyState(elements.backupList);

    backups.forEach((backup) => {
      const item = document.createElement('button');
      item.type = 'button';
      item.className = 'backup-entry';
      item.innerHTML = `
        <div>
          <div class="entry-title">${escapeHtml(backup.fileName)}</div>
          <div class="entry-meta">${escapeHtml(formatDate(backup.updatedAt || backup.createdAt))} - ${escapeHtml(backup.sizeBytes)} bytes</div>
        </div>
        <div class="queue-badge">restore</div>
      `;
      item.addEventListener('click', () => {
        elements.adminSystemForm.elements.backupFileName.value = backup.fileName;
        setAdminStatus(`Backup selectat pentru restore: ${backup.fileName}`, 'ready');
      });
      elements.backupList.appendChild(item);
    });
  }

  async function loadAuditLog() {
    try {
      if (!state.guildId || !canReadAdminData()) {
        setEmptyState(elements.auditLog, 'Audit log disponibil doar dupa autentificare admin pe un guild permis.');
        return;
      }

      const payload = await fetchJson(buildApiPath('/api/admin/audit-log?limit=30'), {
        headers: getAdminRequestHeaders({ Accept: 'application/json' }),
        credentials: 'same-origin',
      });
      renderAuditLog(payload.entries || []);
    } catch (error) {
      setEmptyState(elements.auditLog, `Nu pot incarca audit log: ${error.message}`);
    }
  }

  async function loadBackups() {
    try {
      if (!state.guildId || !canReadAdminData()) {
        setEmptyState(elements.backupList, 'Lista de backup-uri este disponibila doar dupa autentificare admin.');
        return;
      }

      const payload = await fetchJson(buildApiPath('/api/admin/backups'), {
        headers: getAdminRequestHeaders({ Accept: 'application/json' }),
        credentials: 'same-origin',
      });
      renderBackupList(payload.backups || []);
    } catch (error) {
      setEmptyState(elements.backupList, `Nu pot incarca backup-urile: ${error.message}`);
    }
  }

  function hydrateAdminFormFromMatch(match) {
    elements.adminMatchForm.elements.matchId.value = match.id || '';
    elements.adminMatchForm.elements.dotaMatchId.value = match.dotaMatchId || '';
  }

  function hydrateAdminFormFromPlayer(player) {
    elements.adminPlayerForm.elements.userId.value = player.userId || '';
    elements.adminMatchForm.elements.userId.value = player.userId || '';
  }

  function renderMatchDetails(match) {
    state.selectedMatchId = match.id;
    state.selectedPlayerId = null;
    hydrateAdminFormFromMatch(match);
    elements.detailsTitle.textContent = `Match ${match.id}`;

    const radiantRows = match.radiantPlayers.length
      ? match.radiantPlayers
          .map(
            (player) => `
              <div class="detail-list-item">
                <span>${escapeHtml(player.displayName || player.username || player.userId)} - ${escapeHtml(formatRole(player.assignedRole || player.preferredRole))}</span>
                <strong>${player.eloBefore} -> ${player.eloAfter || player.eloBefore}</strong>
              </div>
            `,
          )
          .join('')
      : '<div class="detail-subtle">Fara jucatori.</div>';

    const direRows = match.direPlayers.length
      ? match.direPlayers
          .map(
            (player) => `
              <div class="detail-list-item">
                <span>${escapeHtml(player.displayName || player.username || player.userId)} - ${escapeHtml(formatRole(player.assignedRole || player.preferredRole))}</span>
                <strong>${player.eloBefore} -> ${player.eloAfter || player.eloBefore}</strong>
              </div>
            `,
          )
          .join('')
      : '<div class="detail-subtle">Fara jucatori.</div>';

    elements.detailsBody.classList.remove('empty-state');
    elements.detailsBody.innerHTML = `
      <div class="details-columns">
        <section class="detail-card">
          <h3>Rezumat</h3>
          <div class="detail-list">
            <div class="detail-list-item"><span>Status</span><strong>${escapeHtml(formatStatus(match.status))}</strong></div>
            <div class="detail-list-item"><span>Winner</span><strong>${escapeHtml(match.winningTeam || 'pending')}</strong></div>
            <div class="detail-list-item"><span>Pending</span><strong>${escapeHtml(match.pendingWinningTeam || 'none')}</strong></div>
            <div class="detail-list-item"><span>Creat</span><strong>${escapeHtml(formatDate(match.createdAt))}</strong></div>
            <div class="detail-list-item"><span>Raportat</span><strong>${escapeHtml(formatDate(match.reportedAt))}</strong></div>
            <div class="detail-list-item"><span>STRATZ match</span><strong>${escapeHtml(match.dotaMatchId || 'manual')}</strong></div>
            <div class="detail-list-item"><span>Start joc</span><strong>${escapeHtml(formatTimestampSeconds(match.dotaMatchStartTime))}</strong></div>
            <div class="detail-list-item"><span>Host</span><strong>${escapeHtml(match.hostUserId || 'n/a')}</strong></div>
          </div>
        </section>
        <section class="detail-card">
          <h3>Radiant</h3>
          <div class="detail-list">
            <div class="detail-list-item"><span>Average</span><strong>${match.radiantAverage} ELO</strong></div>
            <div class="detail-list-item"><span>Captain</span><strong>${escapeHtml(match.radiantCaptainUserId || 'n/a')}</strong></div>
            <div class="detail-list-item"><span>ELO delta</span><strong>${match.radiantDelta == null ? 'n/a' : match.radiantDelta}</strong></div>
          </div>
          <div class="detail-list">${radiantRows}</div>
        </section>
        <section class="detail-card">
          <h3>Dire</h3>
          <div class="detail-list">
            <div class="detail-list-item"><span>Average</span><strong>${match.direAverage} ELO</strong></div>
            <div class="detail-list-item"><span>Captain</span><strong>${escapeHtml(match.direCaptainUserId || 'n/a')}</strong></div>
            <div class="detail-list-item"><span>ELO delta</span><strong>${match.direDelta == null ? 'n/a' : match.direDelta}</strong></div>
          </div>
          <div class="detail-list">${direRows}</div>
        </section>
      </div>
    `;
  }

  function renderPlayerDetails(player) {
    state.selectedPlayerId = player.userId;
    hydrateAdminFormFromPlayer(player);
    elements.detailsTitle.textContent = player.displayName || player.username || player.userId;
    const steamLink = player.steam && player.steam.profileUrl
      ? `<a href="${escapeHtml(player.steam.profileUrl)}" target="_blank" rel="noreferrer">${escapeHtml(player.steam.profileName || player.steam.steamId64)}</a>`
      : escapeHtml(player.steam && player.steam.steamId64 ? player.steam.steamId64 : 'neconectat');
    const recentMatches = player.recentMatches.length
      ? player.recentMatches
          .map(
            (match) => `
              <button type="button" class="detail-match-row" data-match-id="${escapeHtml(match.id)}">
                <div class="match-top">
                  <div class="entry-title">${escapeHtml(match.id)}</div>
                  <div class="entry-meta">${escapeHtml(formatDate(match.createdAt))}</div>
                </div>
                <div class="detail-meta">${escapeHtml(formatStatus(match.status))} - ${escapeHtml(match.team || 'n/a')} - ${escapeHtml(formatResult(match.result))} - ${match.eloDelta == null ? 'n/a' : match.eloDelta} ELO</div>
              </button>
            `,
          )
          .join('')
      : '<div class="detail-subtle">Fara meciuri recente.</div>';

    elements.detailsBody.classList.remove('empty-state');
    elements.detailsBody.innerHTML = `
      <div class="details-columns">
        <section class="detail-card">
          <h3>Statistici</h3>
          <div class="detail-list">
            <div class="detail-list-item"><span>ELO</span><strong>${player.elo}</strong></div>
            <div class="detail-list-item"><span>Rol</span><strong>${escapeHtml(formatRole(player.role))}</strong></div>
            <div class="detail-list-item"><span>Record</span><strong>${player.wins}W / ${player.losses}L</strong></div>
            <div class="detail-list-item"><span>Win rate</span><strong>${player.winRate}%</strong></div>
            <div class="detail-list-item"><span>Current streak</span><strong>${player.currentStreak}</strong></div>
            <div class="detail-list-item"><span>Best streak</span><strong>${player.bestWinStreak}</strong></div>
          </div>
        </section>
        <section class="detail-card">
          <h3>Steam</h3>
          <div class="detail-list">
            <div class="detail-list-item"><span>SteamID64</span><strong>${escapeHtml((player.steam && player.steam.steamId64) || 'n/a')}</strong></div>
            <div class="detail-list-item"><span>Account ID</span><strong>${escapeHtml((player.steam && player.steam.accountId) || 'n/a')}</strong></div>
            <div class="detail-list-item"><span>Profil</span><strong>${steamLink}</strong></div>
            <div class="detail-list-item"><span>Ultimul sync</span><strong>${escapeHtml(formatDate(player.steam && player.steam.lastSyncedAt))}</strong></div>
          </div>
        </section>
        <section class="detail-card">
          <h3>Meciuri recente</h3>
          <div class="detail-list">${recentMatches}</div>
        </section>
      </div>
    `;

    elements.detailsBody.querySelectorAll('[data-match-id]').forEach((button) => {
      button.addEventListener('click', () => loadMatchDetails(button.getAttribute('data-match-id')));
    });
  }

  function renderError(message) {
    elements.detailsTitle.textContent = 'Eroare';
    elements.detailsBody.classList.add('empty-state');
    elements.detailsBody.textContent = message;
  }

  async function loadMatchDetails(matchId) {
    try {
      const payload = await fetchJson(buildApiPath(`/api/matches/${encodeURIComponent(matchId)}`));
      renderMatchDetails(payload.match);
    } catch (error) {
      renderError(error.message);
    }
  }

  async function loadPlayerDetails(userId) {
    try {
      const payload = await fetchJson(buildApiPath(`/api/players/${encodeURIComponent(userId)}`));
      renderPlayerDetails(payload.player);
    } catch (error) {
      renderError(error.message);
    }
  }

  function populateAdminDefaults() {
    elements.adminToken.value = state.adminToken;
    elements.adminActorId.value = state.adminActorId;
    setAdminStatus('Admin panel in curs de initializare...', 'ready');
  }

  function getFormValues(form) {
    const formData = new FormData(form);
    return Object.fromEntries(formData.entries());
  }

  function canRunAdminAction() {
    if (state.auth.oauthEnabled && state.auth.authenticated && state.auth.canAdminCurrentGuild) {
      return true;
    }

    return Boolean(state.adminToken);
  }

  async function runAdminAction(action, values) {
    if (!canRunAdminAction()) {
      throw new Error('Autentifica-te cu Discord sau salveaza un token admin valid.');
    }

    const response = await fetch('/api/admin/action', {
      method: 'POST',
      headers: getAdminRequestHeaders({
        Accept: 'application/json',
        'Content-Type': 'application/json',
      }),
      credentials: 'same-origin',
      body: JSON.stringify({
        action,
        guildId: state.guildId,
        actorId: state.adminActorId || undefined,
        ...values,
      }),
    });

    const payload = await response.json();

    if (!response.ok || payload.ok === false) {
      throw new Error(payload.error || 'Admin action failed.');
    }

    return payload.result;
  }

  async function handleAdminAction(action, sourceForm) {
    try {
      setAdminStatus(`Rulez ${action}...`, 'ready');
      const values = getFormValues(sourceForm);

      const normalized = {
        matchId: values.matchId || state.selectedMatchId || undefined,
        dotaMatchId: values.dotaMatchId || undefined,
        winningTeam: values.winningTeam || undefined,
        userId: values.userId || state.selectedPlayerId || undefined,
        backupFileName: values.backupFileName || undefined,
        requeuePlayers: values.requeuePlayers === 'on',
        reason: values.reason || undefined,
        elo: values.elo ? Number(values.elo) : undefined,
      };

      const result = await runAdminAction(action, normalized);
      setAdminStatus(`Actiunea ${action} a reusit.`, 'success');
      await loadDashboard();
      await loadAuditLog();

      if (['createBackup', 'restoreBackup', 'listBackups'].includes(action)) {
        if (action === 'listBackups' && Array.isArray(result)) {
          renderBackupList(result);
        } else {
          await loadBackups();
        }
      }

      if (result && result.id) {
        await loadMatchDetails(result.id);
      } else if (action === 'setElo' && normalized.userId) {
        await loadPlayerDetails(normalized.userId);
      }
    } catch (error) {
      setAdminStatus(error.message, 'error');
    }
  }

  async function downloadAdminFile(format) {
    if (!state.guildId) {
      throw new Error('Selecteaza mai intai un guild.');
    }

    if (!canReadAdminData()) {
      throw new Error('Autentifica-te cu Discord sau salveaza un token admin valid.');
    }

    const response = await fetch(buildApiPath(`/api/admin/audit-export?format=${encodeURIComponent(format)}`), {
      method: 'GET',
      headers: getAdminRequestHeaders(),
      credentials: 'same-origin',
    });

    if (!response.ok) {
      let errorMessage = 'Exportul audit a esuat.';

      try {
        const payload = await response.json();
        errorMessage = payload.error || errorMessage;
      } catch (error) {
        errorMessage = error && error.message ? error.message : errorMessage;
      }

      throw new Error(errorMessage);
    }

    const blob = await response.blob();
    const disposition = response.headers.get('Content-Disposition') || '';
    const fileNameMatch = disposition.match(/filename="([^"]+)"/i);
    const fileName = fileNameMatch ? fileNameMatch[1] : `audit-export.${format}`;
    const downloadUrl = window.URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = downloadUrl;
    link.download = fileName;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => window.URL.revokeObjectURL(downloadUrl), 1000);
  }

  function connectLiveUpdates() {
    if (state.liveSource) {
      state.liveSource.close();
      state.liveSource = null;
    }

    const source = new EventSource(buildApiPath('/api/live'));
    state.liveSource = source;

    source.addEventListener('connected', () => {
      elements.lastRefresh.textContent = `Live conectat pentru guild ${state.guildId || 'auto'}`;
    });

    source.addEventListener('dashboard:update', async () => {
      await loadDashboard();
      await loadAuditLog();
      await loadBackups();
    });

    source.addEventListener('heartbeat', () => {
      if (!elements.lastRefresh.textContent.startsWith('Ultimul refresh')) {
        elements.lastRefresh.textContent = `Live conectat - heartbeat ${formatDate(new Date().toISOString())}`;
      }
    });

    source.onerror = () => {
      elements.lastRefresh.textContent = 'Conexiune live intrerupta, incerc reconectare...';
    };
  }

  async function loadDashboard() {
    try {
      const payload = await fetchJson(buildApiPath('/api/dashboard'));
      renderSummary(payload.summary);
      renderQueue(payload.queue || []);
      renderLeaderboard(payload.leaderboard || []);
      renderMatches(payload.matches || []);
      elements.lastRefresh.textContent = `Ultimul refresh: ${formatDate(payload.summary ? payload.summary.refreshedAt : new Date().toISOString())}`;

      if (state.selectedMatchId) {
        await loadMatchDetails(state.selectedMatchId);
        return;
      }

      if (state.selectedPlayerId) {
        await loadPlayerDetails(state.selectedPlayerId);
        return;
      }

      if ((!elements.detailsBody.textContent || elements.detailsBody.classList.contains('empty-state')) && payload.matches && payload.matches[0]) {
        await loadMatchDetails(payload.matches[0].id);
      }
    } catch (error) {
      elements.lastRefresh.textContent = 'Refresh esuat';
      renderError(error.message);
    }
  }

  function scheduleRefresh() {
    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
    }

    const refreshMs = state.meta && state.meta.refreshMs ? state.meta.refreshMs : 15000;

    if (state.meta && state.meta.liveUpdates) {
      connectLiveUpdates();
      return;
    }

    state.refreshTimer = setInterval(async () => {
      await loadDashboard();
      await loadAuditLog();
      await loadBackups();
    }, refreshMs);
  }

  async function initialize() {
    try {
      populateAdminDefaults();
      const meta = await fetchJson('/api/meta');
      renderMeta(meta);
      await refreshAuthSession();
      renderAuthBox();
      scheduleRefresh();
      await loadDashboard();
      await loadAuditLog();
      await loadBackups();
      setAdminStatus(
        state.auth.oauthEnabled && state.auth.authenticated && state.auth.canAdminCurrentGuild
          ? 'Admin panel activ prin Discord OAuth.'
          : state.adminToken
            ? 'Admin panel activ prin token manual.'
            : 'Admin panel inactiv pana te autentifici cu Discord sau salvezi un token.',
        'ready',
      );
    } catch (error) {
      elements.lastRefresh.textContent = 'Nu pot incarca dashboardul';
      renderError(error.message);
    }
  }

  elements.guildSelect.addEventListener('change', async (event) => {
    state.guildId = event.target.value || null;
    state.selectedMatchId = null;
    state.selectedPlayerId = null;
    syncGuildQueryParam();
    await refreshAuthSession();
    renderAuthBox();
    connectLiveUpdates();
    elements.detailsTitle.textContent = 'Se incarca...';
    elements.detailsBody.classList.add('empty-state');
    elements.detailsBody.textContent = 'Se schimba guildul...';
    await loadDashboard();
    await loadAuditLog();
    await loadBackups();
  });

  elements.adminSave.addEventListener('click', saveAdminSession);

  elements.adminMatchForm.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleAdminAction(button.getAttribute('data-action'), elements.adminMatchForm));
  });

  elements.adminPlayerForm.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleAdminAction(button.getAttribute('data-action'), elements.adminPlayerForm));
  });

  elements.adminSystemForm.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => handleAdminAction(button.getAttribute('data-action'), elements.adminSystemForm));
  });

  elements.exportAuditJson.addEventListener('click', async () => {
    try {
      setAdminStatus('Pregatesc exportul JSON...', 'ready');
      await downloadAdminFile('json');
      setAdminStatus('Exportul JSON a fost descarcat.', 'success');
    } catch (error) {
      setAdminStatus(error.message, 'error');
    }
  });

  elements.exportAuditCsv.addEventListener('click', async () => {
    try {
      setAdminStatus('Pregatesc exportul CSV...', 'ready');
      await downloadAdminFile('csv');
      setAdminStatus('Exportul CSV a fost descarcat.', 'success');
    } catch (error) {
      setAdminStatus(error.message, 'error');
    }
  });

  window.addEventListener('beforeunload', () => {
    if (state.liveSource) {
      state.liveSource.close();
    }

    if (state.refreshTimer) {
      clearInterval(state.refreshTimer);
    }
  });

  initialize();
}());
