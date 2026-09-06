# Deploying

Deploys run through Cloudflare, not GitHub Actions. `.github/workflows/ci.yml`
remains the test gate on every PR and push to `main`.

## Current setup (done)

- D1 database `lunear_games` (`ca24a851-f7f2-4887-a232-e40dfc318c20`), id wired
  in `worker/wrangler.jsonc`; migrations applied with
  `npx wrangler d1 migrations apply lunear_games --remote` from `worker/`.
- `ADMIN_PASSWORD` set as a Worker secret (`npx wrangler secret put ADMIN_PASSWORD`).
  The `admin` account seeds itself with this password on first auth request.
- Custom domains `lunear.org` and `www.lunear.org` attached to the
  `lunear-games-worker` Worker.

## Manual deploy

```
npm run build                 # repo root: builds web/dist, typechecks worker
cd worker
npx wrangler d1 migrations apply lunear_games --remote   # when new migrations exist
npx wrangler deploy
```

## Auto-deploy on push (Workers Builds)

Connect the repo once in the Cloudflare dashboard: Workers & Pages →
`lunear-games-worker` → Settings → Builds → Connect → GitHub repo
`Lunear01/lunear.org`, then set:

- Build command: `npm ci && npm run build && npx wrangler d1 migrations apply lunear_games --remote`
- Deploy command: `npx wrangler deploy`
- Root directory: `/` (build command runs at repo root; wrangler picks up
  `worker/wrangler.jsonc` via `--config` — set deploy command to
  `npx wrangler deploy --config worker/wrangler.jsonc` if the root-dir default
  cannot find it, or set root directory to `worker` and prefix the build
  command with `cd ..`).

The build authenticates with a Cloudflare-generated token; no GitHub secrets
are needed.
