# Changelog

All notable changes to this project should be documented in this file.

The format is based on Keep a Changelog and this project aims to follow Semantic Versioning where practical.

## [Unreleased]

### Added

- public web dashboard with live queue, leaderboard, summary, and match history
- authenticated web admin panel with Discord OAuth and manual token fallback
- SSE live updates for dashboard refreshes
- internal bot control API for admin mutations
- SQLite backup scheduler, restore tooling, and admin backup controls
- admin audit log with JSON/CSV export
- Discord alerts for backup and admin action failures
- PM2, Docker, Docker Compose, and Caddy deployment support
- production, VPS, and security documentation
- GitHub issue templates, PR template, CODEOWNERS, and CI workflow
- ISC license file and tag-based GitHub release workflow
- Steam lobby env examples and command coverage in the docs

### Changed

- replaced OpenDota integration with STRATZ-backed validation and profile lookup
- split the web dashboard into a separate runtime from the Discord bot
- expanded README and environment documentation for public deployment

### Removed

- old OpenDota service implementation

## [1.0.0] - 2026-03-31

### Added

- initial Discord matchmaking bot with queue, ELO, reporting, and Steam GC lobby flow
