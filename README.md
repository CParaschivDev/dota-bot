# Dota Bot

Discord bot pentru matchmaking Dota 2, roluri, ELO si raportare rezultate.

## Cerinte

- Node.js 18+
- Un bot creat in Discord Developer Portal

## Setup local

1. Instaleaza dependintele:

```bash
npm install
```

2. Completeaza `.env` cu valorile reale:

```env
DISCORD_TOKEN=tokenul_botului
CLIENT_ID=application_id
GUILD_ID=id_server_pentru_testare
NODE_ENV=development
```

3. Ruleaza botul:

```bash
node index.js
```

## Slash commands

- `/join` - intra in queue
- `/leave` - iese din queue
- `/queue` - afiseaza queue-ul curent
- `/role` - seteaza rolul preferat
- `/elo` - afiseaza ELO
- `/leaderboard` - top jucatori
- `/report` - raporteaza castigatorul unui meci

## Deploy VPS

- copiaza proiectul pe server
- seteaza `.env`
- ruleaza `npm install`
- porneste botul cu `node index.js` sau un process manager precum `pm2`
