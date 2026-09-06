import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function createGuest() {
  return SELF.fetch("http://example.com/api/auth/guest", { method: "POST" });
}

describe("POST /api/auth/guest", () => {
  it("creates a guest with 5000 credits, a ledger row, and no cookie", async () => {
    const res = await createGuest();
    expect(res.status).toBe(201);
    expect(res.headers.get("set-cookie")).toBeNull();

    const body = await res.json<{
      id: string;
      username: string;
      credits: number;
      is_admin: boolean;
      is_guest: boolean;
      token: string;
    }>();
    expect(body.username).toMatch(/^Guest_[A-Za-z0-9]{5}$/);
    expect(body.credits).toBe(5000);
    expect(body.is_admin).toBe(false);
    expect(body.is_guest).toBe(true);
    expect(typeof body.token).toBe("string");
    expect(body.token.length).toBeGreaterThan(20);

    const userRow = await env.DB.prepare(
      "SELECT credits, is_guest FROM users WHERE id = ?",
    )
      .bind(body.id)
      .first<{ credits: number; is_guest: number }>();
    expect(userRow?.credits).toBe(5000);
    expect(userRow?.is_guest).toBe(1);

    const ledgerRow = await env.DB.prepare(
      "SELECT amount, reason, idempotency_key FROM credit_ledger WHERE user_id = ?",
    )
      .bind(body.id)
      .first<{ amount: number; reason: string; idempotency_key: string }>();
    expect(ledgerRow?.amount).toBe(5000);
    expect(ledgerRow?.reason).toBe("signup_grant");
    expect(ledgerRow?.idempotency_key).toBe(`signup:${body.id}`);
  });

  it("accepts the guest token as a Bearer header on /api/auth/me", async () => {
    const guestRes = await createGuest();
    const { token, username } = await guestRes.json<{ token: string; username: string }>();

    const meRes = await SELF.fetch("http://example.com/api/auth/me", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(meRes.status).toBe(200);
    const body = await meRes.json<{ username: string; is_guest: boolean }>();
    expect(body.username).toBe(username);
    expect(body.is_guest).toBe(true);
  });

  it("rejects a request with no cookie and no Bearer token", async () => {
    const res = await SELF.fetch("http://example.com/api/auth/me");
    expect(res.status).toBe(401);
  });

  it("accepts the guest token as a `?token=` query param on the table WebSocket route", async () => {
    const guestRes = await createGuest();
    const { token, id: userId } = await guestRes.json<{ token: string; id: string }>();

    const initRes = await SELF.fetch(
      `http://example.com/api/tables/guest-ws-${crypto.randomUUID()}/init`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ gameId: "doudizhu", stake: 100, visibility: "public" }),
      },
    );
    expect(initRes.status).toBe(200);
    const { tableId } = await initRes.json<{ tableId: string }>();

    const wsRes = await SELF.fetch(
      `http://example.com/api/tables/doudizhu/${tableId}/ws?token=${token}`,
      { headers: { Upgrade: "websocket" } },
    );
    expect(wsRes.status).toBe(101);
    const ws = wsRes.webSocket;
    expect(ws).toBeTruthy();
    ws?.accept();
    ws?.close();

    // Sanity: the userId embedded in the token really is this guest.
    const row = await env.DB.prepare("SELECT is_guest FROM users WHERE id = ?")
      .bind(userId)
      .first<{ is_guest: number }>();
    expect(row?.is_guest).toBe(1);
  });

  it("cleans up an expired-session guest but leaves a live one", async () => {
    const staleRes = await createGuest();
    const { id: staleId, token: staleToken } = await staleRes.json<{
      id: string;
      token: string;
    }>();

    // Force the stale guest's only session to be expired.
    await env.DB.prepare("UPDATE sessions SET expires_at = ? WHERE id = ?")
      .bind("2000-01-01T00:00:00.000Z", staleToken)
      .run();

    const liveRes = await createGuest(); // also triggers cleanupStaleGuests()
    const { id: liveId } = await liveRes.json<{ id: string }>();

    const staleRow = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(staleId)
      .first();
    expect(staleRow).toBeNull();

    const liveRow = await env.DB.prepare("SELECT id FROM users WHERE id = ?")
      .bind(liveId)
      .first();
    expect(liveRow).toBeTruthy();
  });
});
