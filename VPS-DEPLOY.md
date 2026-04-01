# VPS Deploy Guide

This guide is copy-paste oriented for a Linux VPS using Docker Compose and Caddy.

## 1. Install Docker and Git

Ubuntu/Debian example:

```bash
sudo apt update
sudo apt install -y ca-certificates curl gnupg git
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
sudo chmod a+r /etc/apt/keyrings/docker.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo $VERSION_CODENAME) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
newgrp docker
```

## 2. Clone the Repository

```bash
git clone https://github.com/CParaschivDev/dota-bot.git
cd dota-bot
```

## 3. Create the Production Environment File

```bash
cp PRODUCTION.env.example .env
nano .env
```

Set at least:

- `DISCORD_TOKEN`
- `CLIENT_ID`
- `GUILD_ID`
- `STRATZ_API_KEY`
- `WEB_ADMIN_TOKEN`
- `BOT_CONTROL_TOKEN`
- `WEB_DOMAIN`
- `DISCORD_OAUTH_CLIENT_ID`
- `DISCORD_OAUTH_CLIENT_SECRET`
- `DISCORD_OAUTH_REDIRECT_URI`

Also set these if the bot should create real Dota lobbies from Discord commands:

- `STEAM_AUTO_LOBBY_ENABLED=true`
- `STEAM_ACCOUNT_NAME`
- `STEAM_PASSWORD`
- `STEAM_SHARED_SECRET`

Recommended production values:

```env
NODE_ENV=production
BOT_CONTROL_HOST=127.0.0.1
BOT_CONTROL_URL=http://127.0.0.1:3001
BACKUP_ON_STARTUP=true
BACKUP_INTERVAL_MINUTES=360
```

## 4. Open Firewall Ports

If you use UFW:

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw enable
sudo ufw status
```

Do not expose port `3001` publicly.

## 5. Start the Stack

```bash
docker compose up --build -d
```

Check status:

```bash
docker compose ps
```

Watch logs:

```bash
docker compose logs -f bot
docker compose logs -f web
docker compose logs -f caddy
docker compose logs -f backup
```

## 6. Verify the Deployment

Run these checks:

```bash
curl -I http://localhost:3000/api/health
curl -I https://your-domain.com/api/health
```

Then verify manually:

- the Discord bot is online
- the dashboard loads on your domain
- Discord OAuth login works
- the admin panel works on an allowed guild
- backup creation works
- audit entries appear after admin actions
- `/test-lobby create name:dada password:1234` creates a Steam-backed lobby if auto-lobby mode is enabled

## 7. Updating the Server Later

```bash
cd ~/dota-bot
git pull origin main
docker compose up --build -d
docker compose ps
```

## 8. Manual Backup and Restore

Manual backup:

```bash
docker compose exec bot node scripts/backup-db.js
```

Manual restore:

```bash
docker compose exec bot node scripts/restore-db.js -- ./backups/dota-bot-YYYY-MM-DDTHH-MM-SS.sqlite
```

## 9. Troubleshooting

If HTTPS does not come up:

- verify `WEB_DOMAIN` points to the VPS public IP
- verify ports `80` and `443` are open
- check `docker compose logs -f caddy`

If admin actions fail:

- verify `WEB_ADMIN_TOKEN` and `BOT_CONTROL_TOKEN` are aligned if you use token fallback
- verify Discord OAuth redirect URL exactly matches the application config
- verify `WEB_ADMIN_ALLOWED_GUILD_IDS` contains the active guild

If the bot cannot validate matches:

- verify `STRATZ_API_KEY`
- check bot logs for STRATZ or Cloudflare-related failures
