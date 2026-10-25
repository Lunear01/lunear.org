import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { EMOTE_COOLDOWN_MS, EmoteRelay, parseEmoteMessage } from "../src/durable-objects/emote-relay";

async function registerUser(): Promise<{ id: string; cookie: string }> {
  const username = `emo${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
  const res = await SELF.fetch("http://example.com/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "correct horse" }),
  });
  const { id } = await res.json<{ id: string }>();
  return { id, cookie: (res.headers.get("set-cookie") ?? "").split(";")[0] };
}

async function setCredits(userId: string, credits: number) {
  await env.DB.prepare("UPDATE users SET credits = ? WHERE id = ?").bind(credits, userId).run();
}

async function stock(userId: string, emoteId: string): Promise<number> {
  const row = await env.DB.prepare("SELECT qty FROM user_emotes WHERE user_id = ? AND emote_id = ?")
    .bind(userId, emoteId)
    .first<{ qty: number }>();
  return row?.qty ?? 0;
}

function buy(cookie: string, emoteId: string, quantity: number) {
  return SELF.fetch("http://example.com/api/shop/emotes/buy", {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify({ emoteId, quantity }),
  });
}

class FakeSocket {
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

describe("emote shop", () => {
  it("buys a bundle: debits price x quantity and adds stock", async () => {
    const { id, cookie } = await registerUser();
    await setCredits(id, 500);
    const res = await buy(cookie, "tomato", 5);
    expect(res.status).toBe(200);
    const body = await res.json<{ credits: number; emoteStock: Record<string, number> }>();
    expect(body.credits).toBe(350);
    expect(body.emoteStock.tomato).toBe(5);
    await buy(cookie, "tomato", 1);
    expect(await stock(id, "tomato")).toBe(6);
  });

  it.each([99, 0, -20])("refuses a balance of %i for a 100-credit emote", async (credits) => {
    const { id, cookie } = await registerUser();
    await setCredits(id, credits);
    expect((await buy(cookie, "champagne", 1)).status).toBe(402);
    expect(await stock(id, "champagne")).toBe(0);
  });

  it("rejects unknown emotes, bad quantities and guests", async () => {
    const { cookie } = await registerUser();
    expect((await buy(cookie, "nope", 1)).status).toBe(400);
    expect((await buy(cookie, "tomato", 3)).status).toBe(400);
    const guest = await SELF.fetch("http://example.com/api/auth/guest", { method: "POST" });
    const { token } = await guest.json<{ token: string }>();
    const res = await SELF.fetch("http://example.com/api/shop/emotes/buy", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ emoteId: "tomato", quantity: 1 }),
    });
    expect(res.status).toBe(403);
  });
});

describe("emote relay", () => {
  it("parses only well-formed emote messages", () => {
    expect(parseEmoteMessage({ type: "emote", emoteId: "cake", target: 1 })).toEqual({ type: "emote", emoteId: "cake", target: 1 });
    expect(parseEmoteMessage({ type: "emote", emoteId: "nope", target: 1 })).toBeNull();
    expect(parseEmoteMessage({ type: "emote", emoteId: "cake", target: "1" })).toBeNull();
    expect(parseEmoteMessage({ type: "play" })).toBeNull();
  });

  it("consumes one, broadcasts to every socket, then enforces the cooldown", async () => {
    const { id, cookie } = await registerUser();
    await setCredits(id, 100);
    await buy(cookie, "rose", 1);
    const relay = new EmoteRelay();
    const a = new FakeSocket();
    const b = new FakeSocket();
    const input = {
      db: env.DB,
      sockets: [a, b] as unknown as WebSocket[],
      from: { seat: 0, userId: id },
      occupied: [0, 1],
      message: { type: "emote" as const, emoteId: "rose" as const, target: 1 },
    };
    expect(await relay.relay(input, 1000)).toEqual({ ok: true });
    expect(JSON.parse(a.sent[0])).toEqual({ type: "emote", from: 0, to: 1, emoteId: "rose" });
    expect(b.sent).toHaveLength(1);
    expect(await stock(id, "rose")).toBe(0);

    await buy(cookie, "rose", 1);
    const cooled = await relay.relay(input, 1000 + EMOTE_COOLDOWN_MS - 1);
    expect(cooled).toMatchObject({ ok: false, code: "emote-cooldown" });
    expect(await stock(id, "rose")).toBe(1);
    expect(await relay.relay(input, 1000 + EMOTE_COOLDOWN_MS)).toEqual({ ok: true });
  });

  it("refuses empty stock, self-targets and empty seats without broadcasting", async () => {
    const { id } = await registerUser();
    const relay = new EmoteRelay();
    const socket = new FakeSocket();
    const base = {
      db: env.DB,
      sockets: [socket] as unknown as WebSocket[],
      from: { seat: 0, userId: id },
      occupied: [0, 1],
    };
    expect(await relay.relay({ ...base, message: { type: "emote", emoteId: "cake", target: 1 } })).toMatchObject({ ok: false, code: "emote-empty" });
    expect(await relay.relay({ ...base, message: { type: "emote", emoteId: "cake", target: 0 } })).toMatchObject({ ok: false, code: "emote-target" });
    expect(await relay.relay({ ...base, message: { type: "emote", emoteId: "cake", target: 2 } })).toMatchObject({ ok: false, code: "emote-target" });
    expect(socket.sent).toHaveLength(0);
  });
});
