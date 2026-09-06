# Deploying

## Required GitHub secrets

- `CLOUDFLARE_API_TOKEN` — token with Workers Scripts (edit) and D1 (edit) permissions.
- `CLOUDFLARE_ACCOUNT_ID` — the Cloudflare account ID the Worker and D1 database live in.

## One-time setup

1. Create the D1 database:
   ```
   npx wrangler d1 create lunear_games
   ```
   Copy the returned `database_id` and paste it over the placeholder
   (`00000000-0000-0000-0000-000000000000`) in `worker/wrangler.jsonc`.

2. Set the admin password as a Worker secret (not in CI):
   ```
   npx wrangler secret put ADMIN_PASSWORD --config worker/wrangler.jsonc
   ```

3. Add the two GitHub secrets above under repo Settings → Secrets and variables → Actions.

## How a deploy flows

- Every pull request and push to `main` runs `.github/workflows/ci.yml`: install,
  generate `worker/worker-configuration.d.ts` (`npm run types -w worker`), typecheck,
  test, build.
- A push to `main` additionally runs `.github/workflows/deploy.yml`: re-runs
  typecheck/test as a gate, builds the web assets, applies D1 migrations
  (`wrangler d1 migrations apply lunear_games --remote`), then deploys
  (`wrangler deploy`) — both from `worker/`.
- No manual deploy step is required once the one-time setup above is done.
