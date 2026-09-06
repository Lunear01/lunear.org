import { applyD1Migrations, env } from "cloudflare:test";
import type { D1Migration } from "@cloudflare/vitest-plugin";

// TEST_MIGRATIONS is injected in vitest.config.ts via a test-only miniflare
// binding (not part of the real Env) — see readD1Migrations() there.
const { TEST_MIGRATIONS } = env as unknown as { TEST_MIGRATIONS: D1Migration[] };

await applyD1Migrations(env.DB, TEST_MIGRATIONS);
