import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

async function registerUser(): Promise<{ id: string; cookie: string }> {
  const username = `shop${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
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

function post(path: string, cookie: string, body: unknown) {
  return SELF.fetch(`http://example.com/api/shop/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", Cookie: cookie },
    body: JSON.stringify(body),
  });
}

async function owned(userId: string): Promise<string[]> {
  const { results } = await env.DB.prepare("SELECT item_id FROM user_items WHERE user_id = ?")
    .bind(userId)
    .all<{ item_id: string }>();
  return results.map((r) => r.item_id);
}

describe("shop", () => {
  it("lists items with classic owned and equipped by default", async () => {
    const { cookie } = await registerUser();
    const res = await SELF.fetch("http://example.com/api/shop", { headers: { Cookie: cookie } });
    const body = await res.json<{ items: { id: string; price: number }[]; owned: string[]; equipped: string }>();
    expect(body.items.find((i) => i.id === "midnight-deco")?.price).toBe(8000);
    expect(body.items.find((i) => i.id === "nebula")?.price).toBe(10000);
    expect(body.owned).toEqual(["classic"]);
    expect(body.equipped).toBe("classic");
  });

  it("buys an item: debits credits, writes a ledger row, grants the item", async () => {
    const { id, cookie } = await registerUser();
    await setCredits(id, 12000);
    const res = await post("buy", cookie, { itemId: "nebula" });
    expect(res.status).toBe(200);
    const body = await res.json<{ credits: number; owned: string[] }>();
    expect(body.credits).toBe(2000);
    expect(body.owned).toContain("nebula");
    const ledger = await env.DB.prepare(
      "SELECT amount, reason FROM credit_ledger WHERE user_id = ? AND reason = 'shop_purchase'",
    )
      .bind(id)
      .first<{ amount: number; reason: string }>();
    expect(ledger?.amount).toBe(-10000);
  });

  it("allows a purchase that spends the exact balance", async () => {
    const { id, cookie } = await registerUser();
    await setCredits(id, 8000);
    expect((await post("buy", cookie, { itemId: "midnight-deco" })).status).toBe(200);
  });

  it.each([7999, 0, -500])("refuses a balance of %i", async (credits) => {
    const { id, cookie } = await registerUser();
    await setCredits(id, credits);
    const res = await post("buy", cookie, { itemId: "midnight-deco" });
    expect(res.status).toBe(402);
    expect(await owned(id)).toEqual([]);
    const row = await env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(id).first<{ credits: number }>();
    expect(row?.credits).toBe(credits);
  });

  it("refuses a second purchase of the same item", async () => {
    const { id, cookie } = await registerUser();
    await setCredits(id, 30000);
    expect((await post("buy", cookie, { itemId: "molten-core" })).status).toBe(200);
    expect((await post("buy", cookie, { itemId: "molten-core" })).status).toBe(409);
    const row = await env.DB.prepare("SELECT credits FROM users WHERE id = ?").bind(id).first<{ credits: number }>();
    expect(row?.credits).toBe(20000);
  });

  it("refuses guests", async () => {
    const guest = await SELF.fetch("http://example.com/api/auth/guest", { method: "POST" });
    const { id, token } = await guest.json<{ id: string; token: string }>();
    await setCredits(id, 50000);
    const res = await SELF.fetch("http://example.com/api/shop/buy", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify({ itemId: "nebula" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects unknown and free items", async () => {
    const { cookie } = await registerUser();
    expect((await post("buy", cookie, { itemId: "nope" })).status).toBe(400);
    expect((await post("buy", cookie, { itemId: "classic" })).status).toBe(400);
  });

  it("equips only owned items and stores classic as NULL", async () => {
    const { id, cookie } = await registerUser();
    expect((await post("equip", cookie, { itemId: "nebula" })).status).toBe(403);
    await setCredits(id, 10000);
    await post("buy", cookie, { itemId: "nebula" });
    const res = await post("equip", cookie, { itemId: "nebula" });
    expect((await res.json<{ equipped: string }>()).equipped).toBe("nebula");
    await post("equip", cookie, { itemId: "classic" });
    const row = await env.DB.prepare("SELECT card_skin FROM users WHERE id = ?").bind(id).first<{ card_skin: string | null }>();
    expect(row?.card_skin).toBeNull();
  });
});
