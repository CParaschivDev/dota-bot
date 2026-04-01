# Release Checklist

Use this checklist before publishing a tagged release.

## Code and Review

- confirm `main` is green in GitHub Actions
- confirm the working tree is clean
- review the latest commits and docs
- update `CHANGELOG.md`

## Config and Security

- verify `.env.example` and `PRODUCTION.env.example` match the current feature set
- verify no secrets were committed
- verify `SECURITY.md` is still accurate
- verify new env vars are documented in `README.md` and `DEPLOY.md`

## Runtime Verification

- run syntax checks locally or via CI
- verify bot startup works
- verify web dashboard startup works
- verify Discord OAuth login works
- verify an admin action succeeds
- verify backup creation and restore flow work
- verify audit export works

## Deploy Verification

- verify Docker Compose configuration still matches docs
- verify PM2 config still matches docs
- verify reverse proxy settings still match `WEB_DOMAIN`
- verify bot control API is still intended to remain private

## GitHub Release

- create a version tag
- publish GitHub release notes
- summarize major changes from `CHANGELOG.md`
- mention any required env or migration changes

Tag example:

```bash
git tag v1.0.1
git push origin v1.0.1
```
