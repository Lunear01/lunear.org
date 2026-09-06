import path from "node:path";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest(async () => {
      const migrationsPath = path.join(import.meta.dirname, "migrations");
      const migrations = await readD1Migrations(migrationsPath);

      return {
        wrangler: { configPath: "./wrangler.jsonc" },
        miniflare: {
          bindings: {
            // Test-only binding so a setup file can apply migrations before tests run.
            TEST_MIGRATIONS: migrations,
            // Fixed test value for the ADMIN_PASSWORD secret (declared via
            // `secrets.required` in wrangler.jsonc). Isolated per-test D1
            // storage means ensureAdminSeeded() re-seeds fresh in every
            // test that hits /api/auth/*, harmlessly.
            ADMIN_PASSWORD: "test-admin-password",
          },
        },
      };
    }),
  ],
  test: {
    setupFiles: ["./test/apply-migrations.ts"],
  },
});
