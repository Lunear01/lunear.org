import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

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

describe("POST /api/auth/register", () => {
  it("creates a user, grants 5000 credits via the ledger, and sets a session cookie", async () => {
    const username = uniqueUsername("alice");
    const res = await register(username, "correct horse");

    expect(res.status).toBe(201);
    const body = await res.json<{
      id: string;
      username: string;
      credits: number;
      is_admin: boolean;
    }>();
    expect(body.username).toBe(username);
    expect(body.credits).toBe(5000);
    expect(body.is_admin).toBe(false);

    const cookie = res.headers.get("set-cookie") ?? "";
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toMatch(/SameSite=Lax/i);
    expect(cookie).toContain("Path=/");

    const userRow = await env.DB.prepare(
      "SELECT credits FROM users WHERE id = ?",
    )
      .bind(body.id)
      .first<{ credits: number }>();
    expect(userRow?.credits).toBe(5000);

    const ledgerRow = await env.DB.prepare(
      "SELECT amount, reason, idempotency_key, game_id FROM credit_ledger WHERE user_id = ?",
    )
      .bind(body.id)
      .first<{
        amount: number;
        reason: string;
        idempotency_key: string;
        game_id: string | null;
      }>();
    expect(ledgerRow?.amount).toBe(5000);
    expect(ledgerRow?.reason).toBe("signup_grant");
    expect(ledgerRow?.idempotency_key).toBe(`signup:${body.id}`);
    expect(ledgerRow?.game_id).toBeNull();
  });

  it("rejects a duplicate username case-insensitively with 409", async () => {
    const username = uniqueUsername("Bob");
    const first = await register(username, "correct horse");
    expect(first.status).toBe(201);

    const second = await register(username.toLowerCase(), "another password");
    expect(second.status).toBe(409);
  });

  it("rejects an invalid username", async () => {
    const res = await register("ab", "correct horse");
    expect(res.status).toBe(400);
  });

  it("rejects a username with disallowed characters", async () => {
    const res = await register("bad name!", "correct horse");
    expect(res.status).toBe(400);
  });

  it("rejects a short password", async () => {
    const res = await register(uniqueUsername("carol"), "short");
    expect(res.status).toBe(400);
  });
});

describe("POST /api/auth/login", () => {
  it("logs in with correct credentials and sets a session cookie", async () => {
    const username = uniqueUsername("dave");
    const password = "correct horse";
    await register(username, password);

    const res = await login(username, password);
    expect(res.status).toBe(200);
    const body = await res.json<{ username: string; credits: number }>();
    expect(body.username).toBe(username);
    expect(res.headers.get("set-cookie")).toBeTruthy();
  });

  it("rejects wrong password with 401", async () => {
    const username = uniqueUsername("erin");
    await register(username, "correct horse");

    const res = await login(username, "wrong password");
    expect(res.status).toBe(401);
  });

  it("locks out a username after 10 failed attempts within the window", async () => {
    const username = uniqueUsername("locky");
    await register(username, "correct horse");

    for (let i = 0; i < 10; i++) {
      const res = await login(username, "wrong password");
      expect(res.status).toBe(401);
    }

    const lockedRes = await login(username, "wrong password");
    expect(lockedRes.status).toBe(429);

    // Even the correct password is rejected while locked.
    const lockedWithCorrectRes = await login(username, "correct horse");
    expect(lockedWithCorrectRes.status).toBe(429);
  });

  it("rejects an unknown user with 401 and the same message as wrong password", async () => {
    const wrongPasswordRes = await (async () => {
      const username = uniqueUsername("frank");
      await register(username, "correct horse");
      return login(username, "wrong password");
    })();
    const unknownUserRes = await login(uniqueUsername("ghost"), "whatever1");

    expect(unknownUserRes.status).toBe(401);
    const [wrongBody, unknownBody] = await Promise.all([
      wrongPasswordRes.json<{ error: string }>(),
      unknownUserRes.json<{ error: string }>(),
    ]);
    expect(unknownBody.error).toBe(wrongBody.error);
  });
});

describe("GET /api/auth/me", () => {
  it("returns the current user for a valid session cookie", async () => {
    const username = uniqueUsername("heidi");
    const password = "correct horse";
    const registerRes = await register(username, password);
    const cookie = extractCookie(registerRes);

    const res = await SELF.fetch("http://example.com/api/auth/me", {
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = await res.json<{ username: string; credits: number }>();
    expect(body.username).toBe(username);
    expect(body.credits).toBe(5000);
  });

  it("returns 401 without a session cookie", async () => {
    const res = await SELF.fetch("http://example.com/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("returns 401 for an expired session", async () => {
    const username = uniqueUsername("ivan");
    const registerRes = await register(username, "correct horse");
    const cookie = extractCookie(registerRes);
    const sessionId = cookie.split("=")[1];

    await env.DB.prepare(
      "UPDATE sessions SET expires_at = ? WHERE id = ?",
    )
      .bind("2000-01-01T00:00:00.000Z", sessionId)
      .run();

    const res = await SELF.fetch("http://example.com/api/auth/me", {
      headers: { cookie },
    });
    expect(res.status).toBe(401);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE id = ?",
    )
      .bind(sessionId)
      .first<{ n: number }>();
    expect(remaining?.n ?? 0).toBe(0);
  });
});

describe("POST /api/auth/logout", () => {
  it("deletes the session and clears the cookie", async () => {
    const username = uniqueUsername("judy");
    const registerRes = await register(username, "correct horse");
    const cookie = extractCookie(registerRes);
    const sessionId = cookie.split("=")[1];

    const logoutRes = await SELF.fetch("http://example.com/api/auth/logout", {
      method: "POST",
      headers: { cookie },
    });
    expect(logoutRes.status).toBe(200);

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE id = ?",
    )
      .bind(sessionId)
      .first<{ n: number }>();
    expect(remaining?.n ?? 0).toBe(0);

    const meRes = await SELF.fetch("http://example.com/api/auth/me", {
      headers: { cookie },
    });
    expect(meRes.status).toBe(401);
  });
});
