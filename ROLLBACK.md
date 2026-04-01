# Rollback Guide

Use this guide when a deploy needs to be reverted quickly.

## Roll Back To The Stable Branch

```bash
cd ~/dota-bot
git checkout stable
git pull origin stable
docker compose up --build -d
docker compose ps
```

## Roll Back To A Release Tag

```bash
cd ~/dota-bot
git fetch --tags origin
git checkout v1.0.1
docker compose up --build -d
docker compose ps
```

## Roll Back To A Specific Commit

```bash
cd ~/dota-bot
git log --oneline -n 10
git checkout <commit_sha>
docker compose up --build -d
docker compose ps
```

## Restore SQLite From Backup

```bash
cd ~/dota-bot
docker compose exec bot node scripts/restore-db.js -- ./backups/dota-bot-YYYY-MM-DDTHH-MM-SS.sqlite
docker compose restart bot web backup
docker compose ps
```

## Verify After Rollback

```bash
curl -fsS https://your-domain.com/api/health
npm run ops:health:bot
npm run ops:health:web
docker compose logs --since=10m bot
docker compose logs --since=10m web
```

## Recommended Policy

- deploy to VPS from `stable`
- keep day-to-day development on `main`
- use version tags for release checkpoints
- create a backup before risky restores or schema-affecting changes
