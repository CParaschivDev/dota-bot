# Dota Bot

Bot Discord pentru matchmaking Dota 2, ELO, queue management si raportare rezultate, plus dashboard web public separat pentru vizualizare live.

## Ce include acum

- bot Discord pentru queue, partide, serii si rezultate
- validare de meci prin STRATZ pentru `submit-match`
- dashboard web separat cu leaderboard, queue, sumar si istoric meciuri
- persistenta SQLite pentru bot si dashboard

## Cerinte

- Node.js 18+
- un bot creat in Discord Developer Portal
- token STRATZ pentru validare profile/meciuri

## Setup local

1. Instaleaza dependintele:

```bash
npm install
```

2. Completeaza `.env` plecand de la `.env.example`:

```env
DISCORD_TOKEN=tokenul_botului
CLIENT_ID=application_id
GUILD_ID=id_server_pentru_testare
NODE_ENV=development
DATABASE_PATH=./src/data/dota-bot.sqlite
STRATZ_API_KEY=token_stratz
STRATZ_GRAPHQL_URL=https://api.stratz.com/graphql
STRATZ_TIMEOUT_MS=15000
WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_DEFAULT_GUILD_ID=id_server_pentru_dashboard
WEB_REFRESH_MS=15000
WEB_LIVE_HEARTBEAT_MS=25000
WEB_DB_WATCH_DEBOUNCE_MS=400
WEB_TITLE=Dota Matchmaking Pulse
WEB_ADMIN_TOKEN=token_secret_pentru_admin_web
WEB_ADMIN_ACTOR_ID=discord_user_id_optional
WEB_ADMIN_ALLOWED_GUILD_IDS=711497061651972117,123456789012345678
DISCORD_OAUTH_CLIENT_ID=discord_application_id
DISCORD_OAUTH_CLIENT_SECRET=discord_oauth_secret
DISCORD_OAUTH_REDIRECT_URI=https://domeniul-tau.ro/auth/discord/callback
DISCORD_OAUTH_SCOPES=identify guilds
BOT_CONTROL_HOST=127.0.0.1
BOT_CONTROL_PORT=3001
BOT_CONTROL_TOKEN=token_secret_pentru_bot_control
BOT_CONTROL_URL=http://127.0.0.1:3001
WEB_DOMAIN=domeniul-tau.ro
BACKUP_DIRECTORY=./backups
BACKUP_RETENTION_COUNT=15
BACKUP_INTERVAL_MINUTES=360
BACKUP_ON_STARTUP=true
WEB_ALERT_CHANNEL_ID=
```

3. Ruleaza botul Discord:

```bash
npm start
```

4. Ruleaza dashboardul web separat:

```bash
npm run start:web
```

Botul porneste si un API intern de control pe `BOT_CONTROL_PORT`, folosit de dashboard pentru actiuni admin securizate.

5. Deschide dashboardul in browser:

```text
http://localhost:3000
```

## Slash commands

- `/join` - intra in queue
- `/leave` - iese din queue
- `/queue` - afiseaza queue-ul curent
- `/role` - seteaza rolul preferat
- `/elo` - afiseaza ELO
- `/leaderboard` - top jucatori
- `/steam` - link / info / unlink pentru profil Steam
- `/submit-match` - valideaza meciul prin STRATZ si raporteaza automat castigatorul
- `/report` - raportare manuala a rezultatului

## Dashboard web

Dashboardul citeste aceeasi baza SQLite ca botul si expune un API read-only intern plus o interfata statica.

Endpointuri utile:

- `GET /api/health`
- `GET /api/meta`
- `GET /api/dashboard`
- `GET /api/live` (Server-Sent Events pentru update live)
- `GET /api/summary`
- `GET /api/leaderboard?limit=20`
- `GET /api/queue`
- `GET /api/matches?limit=20`
- `GET /api/matches/:matchId`
- `GET /api/players/:userId`
- `POST /api/admin/action`

Poti selecta guildul prin query string, de exemplu:

```text
http://localhost:3000/?guildId=1234567890
```

## Admin panel web

Dashboardul are acum si actiuni admin direct din browser.

Autentificare recomandata:

- Discord OAuth pentru sesiune web reala
- fallback cu `WEB_ADMIN_TOKEN` doar daca OAuth nu este configurat sau pentru bootstrap

Cum functioneaza:

- browserul trimite `POST /api/admin/action` catre serverul web
- serverul web valideaza sesiunea Discord si verifica daca ai `Manage Server` sau `Administrator` pe guildul selectat
- serverul web trimite comanda catre API-ul intern al botului de la `BOT_CONTROL_URL`
- botul executa mutatia reala in SQLite si in logica lui de matchmaking
- dashboardul primeste update live prin SSE si isi reincarca automat starea

Actiuni disponibile din web:

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
- export audit log JSON/CSV

Recomandare:

- foloseste aceeasi valoare pentru `WEB_ADMIN_TOKEN` si `BOT_CONTROL_TOKEN`
- tine `BOT_CONTROL_HOST=127.0.0.1` ca sa nu expui API-ul intern in retea
- seteaza `DISCORD_OAUTH_REDIRECT_URI` pe URL-ul public real al dashboardului
- seteaza `WEB_ADMIN_ALLOWED_GUILD_IDS` daca vrei sa limitezi admin panel doar la anumite servere Discord

Atentie:

- tokenul admin este salvat local in browser pentru sesiunea ta
- nu folosi un token slab sau reutilizat in alte servicii
- sesiunea Discord se salveaza in cookie HttpOnly si se valideaza pe server

## Observatii STRATZ

- integrarea foloseste GraphQL la `STRATZ_GRAPHQL_URL`
- cheia STRATZ ramane doar pe backend, nu este expusa in frontend
- schema STRATZ poate varia; adaptorul din `src/services/stratzService.js` incearca mai multe forme de query compatibile
- daca STRATZ raspunde cu challenge Cloudflare, validarea externa va esua pana cand cheia/rutele folosite sunt acceptate de STRATZ

## Structura noua

- `src/index.js` - bootstrap pentru botul Discord
- `src/services/stratzService.js` - adaptor STRATZ
- `src/web/index.js` - server HTTP pentru dashboard
- `src/web/dashboardData.js` - agregari read-only din SQLite
- `src/web/public/` - frontend static pentru dashboard
- `web.js` - entrypoint separat pentru dashboard

## Deploy

- ruleaza botul si dashboardul ca doua procese separate in acelasi repo
- ambele trebuie sa pointeze la acelasi `DATABASE_PATH`
- daca folosesti PM2, Docker sau systemd, separa procesul bot de procesul web

### PM2

Ai deja configuratia pentru ambele procese in `ecosystem.config.js`:

```bash
pm2 start ecosystem.config.js
```

### Docker

Imaginea pornește botul si dashboardul in acelasi container:

```bash
docker build -t dota-bot .
docker run --env-file .env -p 3000:3000 -p 3001:3001 dota-bot
```

Porturi utile:

- `3000` - dashboard web
- `3001` - bot control API intern; ideal sa ramana expus doar local sau deloc in productie

### Docker Compose + Caddy

Pentru deploy mai curat ai acum `docker-compose.yml` si `deploy/Caddyfile`:

```bash
docker compose up --build -d
```

Servicii:

- `bot` - proces Discord + bot control API
- `web` - dashboard HTTP
- `caddy` - reverse proxy public pentru dashboard

`Caddy` foloseste variabila `WEB_DOMAIN`, iar traficul public intra doar prin proxy.

### Docker Compose override pentru local dev

Fisierul `docker-compose.override.yml` este pregatit pentru dezvoltare locala si face bind mount pe repo:

```bash
docker compose up --build
```

In local dev expune:

- `3000` pentru dashboard
- `3001` pentru bot control API
- `8080` pentru Caddy HTTP
- `8443` pentru Caddy HTTPS

### Backup-uri SQLite

Ai scriptul:

```bash
npm run backup:db
```

Si restore manual:

```bash
npm run restore:db -- ./backups/dota-bot-YYYY-MM-DDTHH-MM-SS.sqlite
```

Ce face:

- copiaza baza SQLite in `BACKUP_DIRECTORY`
- pastreaza doar ultimele `BACKUP_RETENTION_COUNT` backup-uri
- functioneaza si in container, deoarece volumul `dota_backups` este montat in `/app/backups`
- la restore, verifica integritatea backupului si face mai intai o copie de siguranta a bazei curente
- admin panel-ul poate lista backup-urile existente, crea un backup nou si porni restore-ul direct din browser

### Backup automat

- botul ruleaza si un scheduler intern de backup la fiecare `BACKUP_INTERVAL_MINUTES`
- daca `BACKUP_ON_STARTUP=true`, face si un backup imediat la pornire
- in PM2 exista si procesul `dota-backup` cu cron la 6 ore, pentru redundanta operationala

### Audit log admin

Actiunile din admin panel sunt inregistrate in `admin_audit_log` si pot fi vazute direct din dashboard.

Se salveaza:

- actiunea
- actorul si sursa autentificarii
- target-ul
- statusul `success` / `error`
- payload detaliat si eventuale erori

In plus:

- poti exporta audit log-ul din UI in JSON sau CSV
- exportul si vizualizarea auditului respecta aceleasi reguli de admin auth ca mutatiile web

### Alerte Discord

- seteaza `WEB_ALERT_CHANNEL_ID` ca ID-ul canalului unde vrei alertele operationale
- botul trimite alerte pentru esecuri de backup automat
- botul trimite alerte si pentru actiuni admin web care esueaza
