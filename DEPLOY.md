# Deploy Guide

This project is designed to run as two separate services that share the same SQLite database:

- `bot` - Discord bot + internal admin control API
- `web` - public dashboard + web admin UI

## Production Checklist

- set a real `.env` file based on `.env.example`
- configure Steam credentials if you want the bot to create and launch real Dota lobbies
- keep `BOT_CONTROL_HOST=127.0.0.1` unless you explicitly need remote access
- use a strong shared secret for `WEB_ADMIN_TOKEN` and `BOT_CONTROL_TOKEN`
- set `WEB_ADMIN_ALLOWED_GUILD_IDS` if the admin panel should only work for specific Discord servers
- configure Discord OAuth before exposing the admin panel publicly
- point both services to the same `DATABASE_PATH`
- make sure `BACKUP_DIRECTORY` is persisted across restarts
- set `WEB_ALERT_CHANNEL_ID` if you want Discord alerts for failures
- review `MONITORING.md` before the first live deploy

## Required Environment Variables

Minimum production values:

```env
DISCORD_TOKEN=
CLIENT_ID=
DATABASE_PATH=./src/data/dota-bot.sqlite
STRATZ_API_KEY=
WEB_PORT=3000
WEB_ADMIN_TOKEN=
BOT_CONTROL_TOKEN=
BOT_CONTROL_URL=http://127.0.0.1:3001
WEB_DOMAIN=your-domain.com
```

Required additionally for Steam GC lobby creation:

```env
STEAM_AUTO_LOBBY_ENABLED=true
STEAM_ACCOUNT_NAME=
STEAM_PASSWORD=
STEAM_SHARED_SECRET=
STEAM_DATA_DIRECTORY=./src/data/steam
```

Recommended for public admin auth:

```env
DISCORD_OAUTH_CLIENT_ID=
DISCORD_OAUTH_CLIENT_SECRET=
DISCORD_OAUTH_REDIRECT_URI=https://your-domain.com/auth/discord/callback
WEB_ADMIN_ALLOWED_GUILD_IDS=
WEB_ALERT_CHANNEL_ID=
```

## PM2

Start all processes:

```bash
pm2 start ecosystem.config.js
```

Useful commands:

```bash
pm2 status
pm2 logs dota-bot
pm2 logs dota-web
pm2 logs dota-backup
pm2 save
```

## Docker Compose

Build and start the full stack:

```bash
docker compose up --build -d
```

The image itself now defaults to a single process (`node index.js`). Docker Compose is responsible for starting the bot, web, and backup roles separately.

Services included:

- `bot`
- `web`
- `caddy`
- `backup`

Hardening notes in the current compose setup:

- services run with `no-new-privileges`
- `bot`, `web`, and `backup` use `read_only: true`
- writable runtime state stays on mounted volumes and `/tmp`
- dependent services wait for container healthchecks before starting

Useful commands:

```bash
docker compose ps
docker compose logs -f bot
docker compose logs -f web
docker compose logs -f caddy
docker compose logs -f backup
docker compose ps
```

Also see `MONITORING.md` for a shorter operational checklist.

## Reverse Proxy

`deploy/Caddyfile` expects:

- `WEB_DOMAIN` to be set to your public domain
- the `web` container to be reachable on port `3000`

Public traffic should go through Caddy only.

Caddy also sets basic security headers for HSTS, content type sniffing, clickjacking protection, and referrer policy.

## Backups and Restore

Manual backup:

```bash
npm run backup:db
```

Manual restore:

```bash
npm run restore:db -- ./backups/dota-bot-YYYY-MM-DDTHH-MM-SS.sqlite
```

The web admin panel can also:

- create backups
- list backups
- restore a selected backup
- export admin audit logs as JSON or CSV

## Post-Deploy Verification

After deployment, verify:

1. the bot logs into Discord successfully
2. the dashboard loads at your public URL
3. `/api/health` responds successfully
4. Discord OAuth login works
5. admin actions succeed from the web panel
6. a manual backup can be created
7. audit log entries appear in the dashboard
8. the internal bot control API is not publicly exposed
9. `/test-lobby create name:dada password:1234` works if Steam GC mode is enabled

## Suggested GitHub Repo Metadata

Description:

```text
Discord bot for Dota 2 matchmaking with STRATZ validation, web dashboard, admin controls, backups, and live updates.
```

Suggested topics:

```text
discord-bot dota2 matchmaking sqlite stratz dashboard oauth docker pm2 caddy
```
