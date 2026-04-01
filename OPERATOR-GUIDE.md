# Operator Guide

This guide focuses on day-to-day bot operation, especially Steam-backed lobby flows and admin actions.

## Core Operating Modes

- without Steam credentials: queue, ELO, reporting, STRATZ validation, dashboard, and admin tools work
- with Steam credentials and `STEAM_AUTO_LOBBY_ENABLED=true`: the bot can also create and control real Dota lobbies through Steam GC

## Common Player Flows

### Join the matchmaking queue

- `/join`
- `/leave`
- `/queue`
- `/role`
- `/party`

### Inspect player or match state

- `/elo`
- `/leaderboard`
- `/match`
- `/match-history`
- `/steam info`

### Report results

- `/report`
- `/confirm-result`
- `/deny-result`
- `/submit-match`

## Steam Lobby Operations

### Create a test lobby manually

Use this when you want to validate that the Steam account and GC integration are healthy:

```text
/test-lobby create name:dada password:1234
```

Then use:

- `/test-lobby launch`
- `/test-lobby close`

### Launch a real match lobby

When the bot has already created the lobby for an actual match, use:

```text
/launch-lobby match_id:M0001
```

### Host and captain controls

- `/claim-host`
- `/set-host`
- `/set-captain`

## Series Operations

- `/create-series`
- `/series`
- `/series-next`
- `/set-series-sides`
- `/pause-series`
- `/resume-series`
- `/close-series`
- `/cancel-series`

## Queue and Match Admin Operations

- `/cancelmatch`
- `/setelo`
- `/removefromqueue`
- `/queue-panel`
- `/undo-report`

## Web Admin Panel Operations

From the dashboard you can:

- report or confirm results
- set host or captain
- set ELO
- cancel matches
- undo reports
- create backups
- list backups
- restore backups
- export audit logs as JSON or CSV

## Recommended Smoke Checks

After a fresh deploy:

1. open the public dashboard
2. confirm Discord OAuth login works
3. run `/queue`
4. run `/test-lobby create name:dada password:1234`
5. run `/test-lobby launch`
6. run `/test-lobby close`
7. create a manual backup from the web UI
8. confirm the audit log recorded the action

## Failure Triage

If Steam lobby creation fails:

- verify `STEAM_AUTO_LOBBY_ENABLED=true`
- verify `STEAM_ACCOUNT_NAME`, `STEAM_PASSWORD`, and `STEAM_SHARED_SECRET`
- inspect bot logs for Steam Guard, GC disconnect, or account limitation errors

If admin actions fail:

- verify OAuth config
- verify `WEB_ADMIN_ALLOWED_GUILD_IDS`
- verify `BOT_CONTROL_URL` and `BOT_CONTROL_TOKEN`

If match validation fails:

- verify `STRATZ_API_KEY`
- inspect logs for STRATZ request failures or Cloudflare challenges
