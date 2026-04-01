# Release Policy

This repository uses a simple flow:

- `main` for active development
- version tags for release checkpoints
- `stable` for deploy-ready VPS updates

## Recommended Flow

1. merge or push tested work to `main`
2. wait for CI on `main` to pass
3. create a release tag such as `v1.0.1`
4. verify the GitHub Release workflow succeeds
5. promote the approved ref to `stable`
6. deploy the VPS from `stable`

## How To Promote To Stable

Option 1: GitHub Actions

- open the `Promote Stable` workflow
- set `source_ref` to `main`, a release tag, or a specific commit SHA
- run the workflow manually

Option 2: Git locally

```bash
git checkout stable
git reset --hard origin/main
git push origin stable --force-with-lease
```

Use the local option only if you explicitly want to move `stable` from your machine.

## Deployment Rule

- production VPS deploys should pull from `stable`
- emergency rollback can use `stable`, a release tag, or a direct backup restore depending on the incident

## Suggested Habit

- tag every meaningful production-ready milestone
- keep `CHANGELOG.md` updated before tagging
- avoid deploying straight from `main` unless you are intentionally skipping the promotion step
