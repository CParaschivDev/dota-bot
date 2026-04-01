# Monitoring Guide

This is a minimal monitoring checklist for production.

## Core Health Checks

- public dashboard health: `curl -fsS https://your-domain.com/api/health`
- local web health: `curl -fsS http://127.0.0.1:3000/api/health`
- internal bot control health: `curl -fsS http://127.0.0.1:3001/health`

## Docker Compose Logs

```bash
docker compose logs -f bot
docker compose logs -f web
docker compose logs -f caddy
docker compose logs -f backup
```

## What To Watch

### Bot

- Discord login failures
- slash command exceptions
- matchmaking service errors
- Steam login or GC disconnect events
- STRATZ request failures

### Web

- `/api/health` failures
- Discord OAuth callback failures
- admin action failures
- bot control connectivity failures

### Backups

- missing scheduled backups
- backup integrity failures
- restore errors
- Discord alert delivery failures

## Fast Manual Checks

Run after deploy or restart:

```bash
curl -fsS https://your-domain.com/api/health
docker compose ps
docker inspect --format='{{json .State.Health}}' $(docker compose ps -q bot)
docker inspect --format='{{json .State.Health}}' $(docker compose ps -q web)
docker compose logs --since=10m bot
docker compose logs --since=10m web
ls backups
```

Then verify in Discord:

- `/queue`
- `/test-lobby create name:dada password:1234`
- `/test-lobby launch`
- `/test-lobby close`

## Recommended Alerts

- process restart loops for `bot`, `web`, or `backup`
- HTTP health check failure on `/api/health`
- no backup created within expected interval
- Steam GC login or lobby creation failures
- Discord OAuth or admin action failure spikes

## Operational Recommendation

- keep `WEB_ALERT_CHANNEL_ID` configured
- review logs after every deploy
- test one real backup restore periodically on a non-production copy
