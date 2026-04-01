# Security Policy

## Supported Setup

The repository is actively maintained on the latest `main` branch.

## Reporting a Vulnerability

If you discover a security issue, please do not open a public GitHub issue with sensitive details.

Instead:

- contact the maintainer privately through GitHub
- include clear reproduction steps
- include the affected file, endpoint, or workflow
- mention whether the issue affects secrets, authentication, admin actions, backups, or Discord access

## Security Recommendations

- never commit `.env` or production secrets
- use strong random values for `WEB_ADMIN_TOKEN` and `BOT_CONTROL_TOKEN`
- prefer Discord OAuth over manual admin token access
- keep `BOT_CONTROL_HOST=127.0.0.1` in production
- restrict `WEB_ADMIN_ALLOWED_GUILD_IDS` to trusted guilds
- persist backups outside ephemeral containers
- monitor the channel configured by `WEB_ALERT_CHANNEL_ID`
- rotate secrets if you suspect token leakage

## Sensitive Areas

Pay extra attention to:

- Discord OAuth session handling
- web admin endpoints
- internal bot control API exposure
- backup and restore operations
- STRATZ API credentials
- SQLite database files and backup artifacts
