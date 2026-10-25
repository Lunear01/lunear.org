import { Hono } from "hono";
import type { AuthVariables } from "../auth/session";
import { requireAuth } from "../auth/session";
import { SKINS, getSkin, toSkinId } from "../shop/catalog";
import { EMOTES, EMOTE_BUNDLES, getEmote } from "../shop/emotes";

export const shopRoutes = new Hono<{ Bindings: Env; Variables: AuthVariables }>();

shopRoutes.use("*", requireAuth);

async function loadOwned(db: D1Database, userId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT item_id FROM user_items WHERE user_id = ?")
    .bind(userId)
    .all<{ item_id: string }>();
  return ["classic", ...results.map((r) => r.item_id)];
}

async function loadEmoteStock(db: D1Database, userId: string): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("SELECT emote_id, qty FROM user_emotes WHERE user_id = ? AND qty > 0")
    .bind(userId)
    .all<{ emote_id: string; qty: number }>();
  return Object.fromEntries(results.map((r) => [r.emote_id, r.qty]));
}

async function loadShopState(db: D1Database, userId: string) {
  const row = await db
    .prepare("SELECT credits, card_skin FROM users WHERE id = ?")
    .bind(userId)
    .first<{ credits: number; card_skin: string | null }>();
  return {
    items: SKINS,
    owned: await loadOwned(db, userId),
    equipped: toSkinId(row?.card_skin),
    credits: row?.credits ?? 0,
    emotes: EMOTES,
    emoteStock: await loadEmoteStock(db, userId),
  };
}

shopRoutes.get("/", async (c) => c.json(await loadShopState(c.env.DB, c.get("user").id)));

interface ItemBody {
  itemId?: unknown;
}

shopRoutes.post("/buy", async (c) => {
  const user = c.get("user");
  const { itemId } = await c.req.json<ItemBody>().catch(() => ({}) as ItemBody);
  const item = typeof itemId === "string" ? getSkin(itemId) : undefined;
  if (!item || item.price <= 0) return c.json({ error: "unknown item" }, 400);
  if (user.isGuest) return c.json({ error: "register an account to buy items" }, 403);
  if ((await loadOwned(c.env.DB, user.id)).includes(item.id)) {
    return c.json({ error: "already owned" }, 409);
  }

  // One transaction. The ledger row is written only when the live balance
  // covers the price; debit and grant are gated on that row existing.
  // UNIQUE idempotency key blocks a concurrent double buy.
  const key = `shop:${user.id}:${item.id}`;
  let results: D1Result[];
  try {
    results = await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key, note)
         SELECT id, ?, NULL, 'shop_purchase', ?, ? FROM users WHERE id = ? AND credits >= ?`,
      ).bind(-item.price, key, item.id, user.id, item.price),
      c.env.DB.prepare(
        `UPDATE users SET credits = credits - ?
         WHERE id = ? AND EXISTS (SELECT 1 FROM credit_ledger WHERE idempotency_key = ?)`,
      ).bind(item.price, user.id, key),
      c.env.DB.prepare(
        `INSERT INTO user_items (user_id, item_id)
         SELECT ?, ? WHERE EXISTS (SELECT 1 FROM credit_ledger WHERE idempotency_key = ?)`,
      ).bind(user.id, item.id, key),
    ]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.includes("UNIQUE")) return c.json({ error: "already owned" }, 409);
    throw err;
  }
  if (results[0].meta.changes === 0) return c.json({ error: "insufficient credits" }, 402);

  return c.json(await loadShopState(c.env.DB, user.id));
});

shopRoutes.post("/equip", async (c) => {
  const user = c.get("user");
  const { itemId } = await c.req.json<ItemBody>().catch(() => ({}) as ItemBody);
  const item = typeof itemId === "string" ? getSkin(itemId) : undefined;
  if (!item) return c.json({ error: "unknown item" }, 400);
  if (!(await loadOwned(c.env.DB, user.id)).includes(item.id)) {
    return c.json({ error: "not owned" }, 403);
  }
  await c.env.DB.prepare("UPDATE users SET card_skin = ? WHERE id = ?")
    .bind(item.id === "classic" ? null : item.id, user.id)
    .run();
  return c.json(await loadShopState(c.env.DB, user.id));
});

interface EmoteBuyBody {
  emoteId?: unknown;
  quantity?: unknown;
}

shopRoutes.post("/emotes/buy", async (c) => {
  const user = c.get("user");
  const { emoteId, quantity } = await c.req.json<EmoteBuyBody>().catch(() => ({}) as EmoteBuyBody);
  const emote = getEmote(emoteId);
  if (!emote) return c.json({ error: "unknown emote" }, 400);
  if (!EMOTE_BUNDLES.includes(quantity as (typeof EMOTE_BUNDLES)[number])) {
    return c.json({ error: `quantity must be one of ${EMOTE_BUNDLES.join(", ")}` }, 400);
  }
  if (user.isGuest) return c.json({ error: "register an account to buy items" }, 403);

  // Same gating as skin purchases; consumables repeat, so each buy gets a fresh key.
  const total = emote.price * (quantity as number);
  const key = `shop:${user.id}:emote:${crypto.randomUUID()}`;
  const results = await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key, note)
       SELECT id, ?, NULL, 'shop_purchase', ?, ? FROM users WHERE id = ? AND credits >= ?`,
    ).bind(-total, key, `${emote.id} x${quantity}`, user.id, total),
    c.env.DB.prepare(
      `UPDATE users SET credits = credits - ?
       WHERE id = ? AND EXISTS (SELECT 1 FROM credit_ledger WHERE idempotency_key = ?)`,
    ).bind(total, user.id, key),
    c.env.DB.prepare(
      `INSERT INTO user_emotes (user_id, emote_id, qty)
       SELECT ?, ?, ? WHERE EXISTS (SELECT 1 FROM credit_ledger WHERE idempotency_key = ?)
       ON CONFLICT (user_id, emote_id) DO UPDATE SET qty = qty + excluded.qty`,
    ).bind(user.id, emote.id, quantity, key),
  ]);
  if (results[0].meta.changes === 0) return c.json({ error: "insufficient credits" }, 402);

  return c.json(await loadShopState(c.env.DB, user.id));
});
