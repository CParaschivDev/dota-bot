# Dota Bot

![CI](https://github.com/CParaschivDev/dota-bot/actions/workflows/ci.yml/badge.svg)
![Release](https://github.com/CParaschivDev/dota-bot/actions/workflows/release.yml/badge.svg)

Discord bot for Dota 2 matchmaking, ELO, queue management, Steam-powered lobby creation, and result reporting, plus a separate public web dashboard for live visibility.

The bot can create and control real Dota lobbies through Steam Game Coordinator flows, including commands like `/test-lobby create`, `/test-lobby launch`, `/test-lobby close`, and `/launch-lobby`.

## What It Includes

- Discord bot for queue flow, matches, series, and results
- Steam-backed Dota lobby creation, launch, close, and host/captain controls
- STRATZ-based match validation for `submit-match`
- separate web dashboard with leaderboard, queue, summary, and match history
- SQLite persistence shared by the bot and the web dashboard

## Requirements

- Node.js 18+
- a bot application created in the Discord Developer Portal
- a STRATZ token for profile and match validation
- a Steam account is required only if you want automatic Dota lobby creation through the Game Coordinator

## Local Setup

1. Install dependencies:

```bash
npm install
```

2. Fill in `.env` based on `.env.example`:

```env
DISCORD_TOKEN=your_bot_token
CLIENT_ID=application_id
GUILD_ID=test_server_id
NODE_ENV=development
DATABASE_PATH=./src/data/dota-bot.sqlite
STRATZ_API_KEY=your_stratz_token
STRATZ_GRAPHQL_URL=https://api.stratz.com/graphql
STRATZ_TIMEOUT_MS=15000
WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_DEFAULT_GUILD_ID=dashboard_default_guild_id
WEB_REFRESH_MS=15000
WEB_LIVE_HEARTBEAT_MS=25000
WEB_DB_WATCH_DEBOUNCE_MS=400
WEB_TITLE=Dota Matchmaking Pulse
WEB_ADMIN_TOKEN=secret_web_admin_token
WEB_ADMIN_ACTOR_ID=optional_discord_user_id
WEB_ADMIN_ALLOWED_GUILD_IDS=711497061651972117,123456789012345678
DISCORD_OAUTH_CLIENT_ID=discord_application_id
DISCORD_OAUTH_CLIENT_SECRET=discord_oauth_secret
DISCORD_OAUTH_REDIRECT_URI=https://your-domain.com/auth/discord/callback
DISCORD_OAUTH_SCOPES=identify guilds
BOT_CONTROL_HOST=127.0.0.1
BOT_CONTROL_PORT=3001
BOT_CONTROL_TOKEN=secret_bot_control_token
BOT_CONTROL_URL=http://127.0.0.1:3001
WEB_DOMAIN=your-domain.com
BACKUP_DIRECTORY=./backups
BACKUP_RETENTION_COUNT=15
BACKUP_INTERVAL_MINUTES=360
BACKUP_ON_STARTUP=true
WEB_ALERT_CHANNEL_ID=
STEAM_AUTO_LOBBY_ENABLED=false
STEAM_ACCOUNT_NAME=
STEAM_PASSWORD=
STEAM_SHARED_SECRET=
STEAM_DATA_DIRECTORY=./src/data/steam
STEAM_LOBBY_REGION=europe
STEAM_LOBBY_GAME_MODE=captains_mode
STEAM_LOBBY_ALLOW_SPECTATING=false
STEAM_LOBBY_ALLCHAT=false
STEAM_LOBBY_PAUSE_SETTING=unlimited
STEAM_LOBBY_TV_DELAY=120
STEAM_LOBBY_DEBUG=false
```

3. Start the Discord bot:

```bash
npm start
```

4. Start the web dashboard separately:

```bash
npm run start:web
```

The bot also starts an internal control API on `BOT_CONTROL_PORT`, used by the dashboard for secure admin actions.

If you want the bot to create Dota lobbies automatically, also configure the Steam variables and set `STEAM_AUTO_LOBBY_ENABLED=true`.

Without the Steam credentials, queueing, ELO, result reporting, STRATZ validation, and the dashboard still work, but Steam GC lobby creation and launch commands will not.

5. Open the dashboard in your browser:

```text
http://localhost:3000
```

## Slash Commands

The bot currently exposes 32 slash command roots across matchmaking, Steam lobby control, series management, queue administration, and reporting. The `test-lobby` command itself includes `create`, `launch`, and `close` subcommands for Steam-backed test lobbies.

Core player commands:

- `/join` - join the queue
- `/leave` - leave the queue
- `/queue` - show the current queue
- `/role` - set preferred role
- `/elo` - show ELO
- `/leaderboard` - top players
- `/match` - show full details for a specific match
- `/match-history` - show recent match history
- `/party` - create and manage party queue groups
- `/steam` - link / info / unlink Steam profile
- `/report` - manually report a result
- `/confirm-result` - confirm a pending result
- `/deny-result` - dispute a pending result
- `/submit-match` - validate a match through STRATZ and auto-report the winner

Steam and lobby commands:

- `/test-lobby create` - create a solo test Dota lobby through Steam GC with custom name/password
- `/test-lobby launch` - launch the current test lobby
- `/test-lobby close` - close the current test lobby
- `/launch-lobby` - launch an auto-created full match lobby
- `/claim-host` - claim lobby host responsibility
- `/set-host` - admin override for lobby host
- `/set-captain` - admin override for captain selection

Series and admin commands:

- `/create-series`
- `/series`
- `/series-next`
- `/set-series-sides`
- `/pause-series`
- `/resume-series`
- `/close-series`
- `/cancel-series`
- `/cancelmatch`
- `/setelo`
- `/removefromqueue`
- `/queue-panel`
- `/undo-report`

## Web Dashboard

The dashboard reads the same SQLite database as the bot and exposes an internal read-only API plus a static frontend.

Useful endpoints:

- `GET /api/health`
- `GET /api/meta`
- `GET /api/dashboard`
- `GET /api/live` (Server-Sent Events for live updates)
- `GET /api/summary`
- `GET /api/leaderboard?limit=20`
- `GET /api/queue`
- `GET /api/matches?limit=20`
- `GET /api/matches/:matchId`
- `GET /api/players/:userId`
- `POST /api/admin/action`

You can select the guild through the query string, for example:

```text
http://localhost:3000/?guildId=1234567890
```

## Web Admin Panel

The dashboard also includes direct admin actions from the browser.

Recommended authentication:

- Discord OAuth for a real web session
- `WEB_ADMIN_TOKEN` as a fallback only if OAuth is not configured or for bootstrap access

How it works:

- the browser sends `POST /api/admin/action` to the web server
- the web server validates the Discord session and checks whether you have `Manage Server` or `Administrator` on the selected guild
- the web server forwards the command to the bot's internal API at `BOT_CONTROL_URL`
- the bot performs the actual mutation in SQLite and in matchmaking logic
- the dashboard receives live updates through SSE and reloads state automatically

Available web actions:

- report pending result
- confirm result
- deny result
- submit STRATZ result
- set host
- set captain
- set ELO
- cancel match
- undo report
- create backup
- list backups
- restore backup
- export audit log as JSON/CSV

Recommendations:

- use the same value for `WEB_ADMIN_TOKEN` and `BOT_CONTROL_TOKEN`
- keep `BOT_CONTROL_HOST=127.0.0.1` so the internal API is not exposed on the network
- set `DISCORD_OAUTH_REDIRECT_URI` to the real public dashboard URL
- set `WEB_ADMIN_ALLOWED_GUILD_IDS` if you want to limit the admin panel to specific Discord servers

Important:

- the manual admin token is stored locally in your browser for your session
- do not use a weak token or a token reused in other services
- the Discord session is stored in an HttpOnly cookie and validated on the server

## STRATZ Notes

- the integration uses GraphQL at `STRATZ_GRAPHQL_URL`
- the STRATZ key stays on the backend only and is never exposed to the frontend
- the STRATZ schema can vary; the adapter in `src/services/stratzService.js` tries multiple compatible query shapes
- if STRATZ returns a Cloudflare challenge, external validation will fail until the key/routes are accepted by STRATZ

## Updated Structure

- `src/index.js` - Discord bot bootstrap
- `src/services/stratzService.js` - STRATZ adapter
- `src/web/index.js` - dashboard HTTP server
- `src/web/dashboardData.js` - read-only SQLite aggregations
- `src/web/public/` - static dashboard frontend
- `web.js` - separate dashboard entrypoint

## Deploy

- run the bot and dashboard as two separate processes in the same repo
- both must point to the same `DATABASE_PATH`
- if you use PM2, Docker, or systemd, keep the bot process separate from the web process

Additional docs:

- `DEPLOY.md` - production deployment checklist and verification
- `VPS-DEPLOY.md` - copy-paste VPS deployment steps for Docker Compose
- `PRODUCTION.env.example` - production-oriented env template
- `SECURITY.md` - security recommendations and reporting guidance
- `CHANGELOG.md` - tracked project changes
- `RELEASE.md` - release preparation checklist
- `LICENSE` - ISC license
- `OPERATOR-GUIDE.md` - day-to-day commands and Steam lobby operations
- `PRODUCTION.env.full.example` - fuller production env example with Steam enabled
- `MONITORING.md` - minimal production monitoring checks and alerts

### PM2

You already have both process definitions in `ecosystem.config.js`:

```bash
pm2 start ecosystem.config.js
```

### Docker

The image now defaults to a single process and starts the bot entrypoint:

```bash
docker build -t dota-bot .
docker run --env-file .env -p 3001:3001 dota-bot
```

To run the web process with the same image:

```bash
docker run --env-file .env -p 3000:3000 --entrypoint node dota-bot web.js
```

Useful ports:

- `3000` - web dashboard
- `3001` - internal bot control API; ideally keep it local-only or not exposed in production

### Docker Compose + Caddy

For a cleaner deploy, you now have `docker-compose.yml` and `deploy/Caddyfile`:

```bash
docker compose up --build -d
```

Services:

- `bot` - Discord process + bot control API
- `web` - dashboard HTTP server
- `caddy` - public reverse proxy for the dashboard

`Caddy` uses the `WEB_DOMAIN` variable, and all public traffic flows through the proxy.

### Docker Compose Override for Local Dev

`docker-compose.override.yml` is set up for local development and bind-mounts the repo:

```bash
docker compose up --build
```

In local dev it exposes:

- `3000` for the dashboard
- `3001` for the bot control API
- `8080` for Caddy HTTP
- `8443` for Caddy HTTPS

### SQLite Backups

You have the script:

```bash
npm run backup:db
```

And manual restore:

```bash
npm run restore:db -- ./backups/dota-bot-YYYY-MM-DDTHH-MM-SS.sqlite
```

What it does:

- copies the SQLite database into `BACKUP_DIRECTORY`
- keeps only the latest `BACKUP_RETENTION_COUNT` backups
- works in containers too, because the `dota_backups` volume is mounted at `/app/backups`
- on restore, validates backup integrity and creates a safety copy of the current database first
- the admin panel can list existing backups, create a new one, and trigger restore directly from the browser

### Automatic Backups

- the bot runs an internal backup scheduler every `BACKUP_INTERVAL_MINUTES`
- if `BACKUP_ON_STARTUP=true`, it also creates a backup immediately on startup
- PM2 also includes a `dota-backup` process with a 6-hour cron restart for operational redundancy

### Admin Audit Log

Actions from the admin panel are stored in `admin_audit_log` and can be viewed directly in the dashboard.

Stored fields include:

- action
- actor and authentication source
- target
- `success` / `error` status
- detailed payload and any error details

Additionally:

- you can export the audit log from the UI as JSON or CSV
- audit export and audit visibility follow the same admin auth rules as web mutations

### Discord Alerts

- set `WEB_ALERT_CHANNEL_ID` to the channel ID where you want operational alerts
- the bot sends alerts for automatic backup failures
- the bot also sends alerts for failed web admin actions
