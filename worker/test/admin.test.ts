import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

// Matches the ADMIN_PASSWORD test binding in vitest.config.ts.
const ADMIN_USERNAME = "admin";
const ADMIN_TEST_PASSWORD = "test-admin-password";

function uniqueUsername(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

// Cookies come back as `session_id=...; HttpOnly; ...` — extract just the pair
// so it can be replayed on the next request via the Cookie header.
function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header");
  return setCookie.split(";")[0];
}

async function register(username: string, password: string) {
  return SELF.fetch("http://example.com/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

async function login(username: string, password: string) {
  return SELF.fetch("http://example.com/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

async function registerUser(prefix: string) {
  const username = uniqueUsername(prefix);
  const res = await register(username, "correct horse");
  const body = await res.json<{ id: string }>();
  return { id: body.id, username, cookie: extractCookie(res) };
}

// Logs in as the seeded admin, triggering ensureAdminSeeded() on first use.
async function loginAsAdmin(): Promise<{ cookie: string; id: string }> {
  const res = await login(ADMIN_USERNAME, ADMIN_TEST_PASSWORD);
  expect(res.status).toBe(200);
  const body = await res.json<{ id: string }>();
  return { cookie: extractCookie(res), id: body.id };
}

function adjustCredits(
  cookie: string,
  userId: string,
  amount: unknown,
  reason: unknown,
) {
  return SELF.fetch(`http://example.com/api/admin/users/${userId}/credits`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ amount, reason }),
  });
}

function setCredits(
  cookie: string,
  userId: string,
  amount: unknown,
  reason: unknown,
) {
  return SELF.fetch(`http://example.com/api/admin/users/${userId}/credits`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ mode: "set", amount, reason }),
  });
}

function deleteUser(cookie: string, userId: string) {
  return SELF.fetch(`http://example.com/api/admin/users/${userId}`, {
    method: "DELETE",
    headers: { cookie },
  });
}

describe("admin route guards", () => {
  it("returns 401 for unauthenticated requests to all three endpoints", async () => {
    const listRes = await SELF.fetch("http://example.com/api/admin/users");
    expect(listRes.status).toBe(401);

    const creditsRes = await SELF.fetch(
      "http://example.com/api/admin/users/some-id/credits",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amount: 100, reason: "test" }),
      },
    );
    expect(creditsRes.status).toBe(401);

    const deleteRes = await SELF.fetch(
      "http://example.com/api/admin/users/some-id",
      { method: "DELETE" },
    );
    expect(deleteRes.status).toBe(401);
  });

  it("returns 403 for an authenticated non-admin on all three endpoints", async () => {
    const user = await registerUser("nonadmin");

    const listRes = await SELF.fetch("http://example.com/api/admin/users", {
      headers: { cookie: user.cookie },
    });
    expect(listRes.status).toBe(403);

    const creditsRes = await adjustCredits(user.cookie, user.id, 100, "test");
    expect(creditsRes.status).toBe(403);

    const deleteRes = await deleteUser(user.cookie, user.id);
    expect(deleteRes.status).toBe(403);
  });
});

describe("GET /api/admin/users", () => {
  it("lists users newest first and caps limit at 100", async () => {
    const admin = await loginAsAdmin();
    const userA = await registerUser("lista");
    const userB = await registerUser("listb");

    const res = await SELF.fetch("http://example.com/api/admin/users?limit=2", {
      headers: { cookie: admin.cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{
      users: { id: string; username: string; credits: number; is_admin: boolean }[];
      limit: number;
      offset: number;
    }>();
    expect(body.limit).toBe(2);
    expect(body.users).toHaveLength(2);
    expect(body.users[0].id).toBe(userB.id);
    expect(body.users[1].id).toBe(userA.id);
    expect(body.users[0].is_admin).toBe(false);

    const cappedRes = await SELF.fetch(
      "http://example.com/api/admin/users?limit=1000",
      { headers: { cookie: admin.cookie } },
    );
    const cappedBody = await cappedRes.json<{ limit: number }>();
    expect(cappedBody.limit).toBe(100);
  });
});

describe("POST /api/admin/users/:id/credits", () => {
  it("applies a positive then a negative adjustment, driving the balance negative, and ledgers both", async () => {
    const admin = await loginAsAdmin();
    const user = await registerUser("credit");

    const grantRes = await adjustCredits(admin.cookie, user.id, 1000, "bonus");
    expect(grantRes.status).toBe(200);
    expect((await grantRes.json<{ credits: number }>()).credits).toBe(6000);

    const debitRes = await adjustCredits(admin.cookie, user.id, -9000, "penalty");
    expect(debitRes.status).toBe(200);
    expect((await debitRes.json<{ credits: number }>()).credits).toBe(-3000);

    const userRow = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ credits: number }>();
    expect(userRow?.credits).toBe(-3000);

    const ledger = await env.DB.prepare(
      `SELECT amount, reason, note FROM credit_ledger
       WHERE user_id = ? AND reason = 'admin_adjustment' ORDER BY id ASC`,
    )
      .bind(user.id)
      .all<{ amount: number; reason: string; note: string | null }>();
    expect(ledger.results).toHaveLength(2);
    expect(ledger.results?.[0]).toMatchObject({ amount: 1000, note: "bonus" });
    expect(ledger.results?.[1]).toMatchObject({ amount: -9000, note: "penalty" });
  });

  it("rejects a zero amount", async () => {
    const admin = await loginAsAdmin();
    const user = await registerUser("zero");

    const res = await adjustCredits(admin.cookie, user.id, 0, "noop");
    expect(res.status).toBe(400);
  });

  it("rejects a missing reason", async () => {
    const admin = await loginAsAdmin();
    const user = await registerUser("noreason");

    const res = await SELF.fetch(
      `http://example.com/api/admin/users/${user.id}/credits`,
      {
        method: "POST",
        headers: { cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ amount: 100 }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("returns 404 for an unknown user", async () => {
    const admin = await loginAsAdmin();

    const res = await adjustCredits(admin.cookie, crypto.randomUUID(), 100, "test");
    expect(res.status).toBe(404);
  });
});

describe("POST /api/admin/users/:id/credits — mode: 'set'", () => {
  it("sets the balance to an exact value and ledgers the computed delta", async () => {
    const admin = await loginAsAdmin();
    const user = await registerUser("setexact");
    // Seeded balance is 5000 (signup grant); set straight to 12345.
    const res = await setCredits(admin.cookie, user.id, 12345, "reconciliation");
    expect(res.status).toBe(200);
    expect((await res.json<{ credits: number }>()).credits).toBe(12345);

    const userRow = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ credits: number }>();
    expect(userRow?.credits).toBe(12345);

    const ledger = await env.DB.prepare(
      `SELECT amount, note FROM credit_ledger
       WHERE user_id = ? AND reason = 'admin_adjustment' ORDER BY id ASC`,
    )
      .bind(user.id)
      .all<{ amount: number; note: string | null }>();
    expect(ledger.results).toHaveLength(1);
    // 12345 - 5000 (seeded balance) = 7345.
    expect(ledger.results?.[0]).toMatchObject({ amount: 7345, note: "reconciliation" });
  });

  it("sets the balance to a negative value", async () => {
    const admin = await loginAsAdmin();
    const user = await registerUser("setneg");

    const res = await setCredits(admin.cookie, user.id, -500, "clawback");
    expect(res.status).toBe(200);
    expect((await res.json<{ credits: number }>()).credits).toBe(-500);

    const userRow = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ credits: number }>();
    expect(userRow?.credits).toBe(-500);

    const ledger = await env.DB.prepare(
      `SELECT amount FROM credit_ledger WHERE user_id = ? AND reason = 'admin_adjustment'`,
    )
      .bind(user.id)
      .all<{ amount: number }>();
    expect(ledger.results?.[0]?.amount).toBe(-5500);
  });

  it("setting to the current balance is a no-op success with no ledger row", async () => {
    const admin = await loginAsAdmin();
    const user = await registerUser("setsame");
    // Balance is 5000 immediately after registration/seeded grant.
    const res = await setCredits(admin.cookie, user.id, 5000, "noop-set");
    expect(res.status).toBe(200);
    expect((await res.json<{ credits: number }>()).credits).toBe(5000);

    const userRow = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ credits: number }>();
    expect(userRow?.credits).toBe(5000);

    const ledger = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ? AND reason = 'admin_adjustment'`,
    )
      .bind(user.id)
      .first<{ n: number }>();
    expect(ledger?.n ?? 0).toBe(0);
  });

  it("allows a zero-value target amount (not rejected as a no-op-only-when-equal-to-current check)", async () => {
    const admin = await loginAsAdmin();
    const user = await registerUser("setzero");

    const res = await setCredits(admin.cookie, user.id, 0, "zero-out");
    expect(res.status).toBe(200);
    expect((await res.json<{ credits: number }>()).credits).toBe(0);

    const ledger = await env.DB.prepare(
      `SELECT amount FROM credit_ledger WHERE user_id = ? AND reason = 'admin_adjustment'`,
    )
      .bind(user.id)
      .all<{ amount: number }>();
    expect(ledger.results?.[0]?.amount).toBe(-5000);
  });

  it("rejects a missing reason even in set mode", async () => {
    const admin = await loginAsAdmin();
    const user = await registerUser("setnorsn");

    const res = await SELF.fetch(
      `http://example.com/api/admin/users/${user.id}/credits`,
      {
        method: "POST",
        headers: { cookie: admin.cookie, "content-type": "application/json" },
        body: JSON.stringify({ mode: "set", amount: 100 }),
      },
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/admin/users/:id", () => {
  it("deletes the user, cascades their sessions, and invalidates their cookie", async () => {
    const admin = await loginAsAdmin();
    const user = await registerUser("deleteme");

    const meBefore = await SELF.fetch("http://example.com/api/auth/me", {
      headers: { cookie: user.cookie },
    });
    expect(meBefore.status).toBe(200);

    const sessionId = user.cookie.split("=")[1];
    const sessionBefore = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE id = ?",
    )
      .bind(sessionId)
      .first<{ n: number }>();
    expect(sessionBefore?.n ?? 0).toBe(1);

    const deleteRes = await deleteUser(admin.cookie, user.id);
    expect(deleteRes.status).toBe(200);

    const userRow = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(user.id)
      .first();
    expect(userRow).toBeNull();

    const sessionAfter = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE id = ?",
    )
      .bind(sessionId)
      .first<{ n: number }>();
    expect(sessionAfter?.n ?? 0).toBe(0);

    const meAfter = await SELF.fetch("http://example.com/api/auth/me", {
      headers: { cookie: user.cookie },
    });
    expect(meAfter.status).toBe(401);
  });

  it("returns 404 for an unknown user", async () => {
    const admin = await loginAsAdmin();

    const res = await deleteUser(admin.cookie, crypto.randomUUID());
    expect(res.status).toBe(404);
  });

  it("refuses to let the admin delete their own account", async () => {
    const admin = await loginAsAdmin();

    const res = await deleteUser(admin.cookie, admin.id);
    expect(res.status).toBe(400);

    const adminRow = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(admin.id)
      .first();
    expect(adminRow).not.toBeNull();
  });
});

describe("admin seeding", () => {
  it("seeds exactly one admin with 5000 credits on first auth request, without duplicating on a second", async () => {
    const first = await login(ADMIN_USERNAME, ADMIN_TEST_PASSWORD);
    expect(first.status).toBe(200);
    const firstBody = await first.json<{
      username: string;
      credits: number;
      is_admin: boolean;
    }>();
    expect(firstBody.username).toBe(ADMIN_USERNAME);
    expect(firstBody.credits).toBe(5000);
    expect(firstBody.is_admin).toBe(true);

    const second = await login(ADMIN_USERNAME, ADMIN_TEST_PASSWORD);
    expect(second.status).toBe(200);
    expect((await second.json<{ credits: number }>()).credits).toBe(5000);

    const adminCount = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM users WHERE is_admin = 1",
    ).first<{ n: number }>();
    expect(adminCount?.n).toBe(1);

    const grantCount = await env.DB.prepare(
      `SELECT COUNT(*) AS n FROM credit_ledger cl
       JOIN users u ON u.id = cl.user_id
       WHERE u.is_admin = 1 AND cl.reason = 'signup_grant'`,
    ).first<{ n: number }>();
    expect(grantCount?.n).toBe(1);
  });
});
