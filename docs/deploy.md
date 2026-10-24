# Deploying

- **CI**: GitHub Actions (`.github/workflows/ci.yml`) typechecks, tests, and builds every PR
  and push to `main`. A newer push to the same branch cancels the older run.
- **CD**: Cloudflare Workers Builds deploys `lunear-games-worker` on every push to `main`. Its
  build runs the full test suite first, so a failing test stops the deploy.

## Current setup (done)

- D1 database `lunear_games` (`ca24a851-f7f2-4887-a232-e40dfc318c20`), id wired
  in `worker/wrangler.jsonc`.
- `ADMIN_PASSWORD` set as a Worker secret (`npx wrangler secret put ADMIN_PASSWORD`).
  The `admin` account seeds itself with this password on first auth request.
- Custom domains `lunear.org` and `www.lunear.org` attached to the
  `lunear-games-worker` Worker.
- Workers Builds connected to `Lunear01/lunear.org`. It reports to GitHub as the
  `Workers Builds: lunear-games-worker` check.

## Workers Builds settings

Dashboard: Workers & Pages → `lunear-games-worker` → Settings → Builds.

- Production branch: `main`
- Root directory: `/`
- Build command: `npm ci && npm run cf-build`
- Deploy command: `npx wrangler deploy --config worker/wrangler.jsonc`
- Builds for non-production branches: off. `cf-build` applies D1 migrations to the
  production database, so a branch build must never run it.

`npm run cf-build` (root `package.json`) generates worker types, runs every test suite, builds
`web/dist` and typechecks the worker, then applies pending D1 migrations. Any failed step ends
the build before the deploy command runs. Migrations apply before the new code deploys, so a
migration must keep working with the code it replaces.

Node version comes from `.node-version`, matching CI. The build authenticates with a
Cloudflare-generated token; no GitHub secrets are needed.

## Manual deploy

```
npm run cf-build              # repo root: test, build, apply migrations
npx wrangler deploy --config worker/wrangler.jsonc
```
