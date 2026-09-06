import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

type Reason = "signup_grant" | "game_settlement" | "admin_adjustment";

async function insertUser(id: string, username: string) {
  await env.DB.prepare(
    "INSERT INTO users (id, username, password_hash, credits) VALUES (?, ?, ?, 0)",
  )
    .bind(id, username, "hash")
    .run();
}

async function insertLedgerEntry(opts: {
  userId: string;
  amount: number;
  gameId?: string | null;
  reason: Reason;
  idempotencyKey?: string | null;
}) {
  await env.DB.prepare(
    `INSERT INTO credit_ledger (user_id, amount, game_id, reason, idempotency_key)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(
      opts.userId,
      opts.amount,
      opts.gameId ?? null,
      opts.reason,
      opts.idempotencyKey ?? null,
    )
    .run();
  await env.DB.prepare("UPDATE users SET credits = credits + ? WHERE id = ?")
    .bind(opts.amount, opts.userId)
    .run();
}

async function ledgerSum(userId: string): Promise<number> {
  const row = await env.DB.prepare(
    "SELECT COALESCE(SUM(amount), 0) AS total FROM credit_ledger WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ total: number }>();
  return row?.total ?? 0;
}

async function currentCredits(userId: string): Promise<number | null> {
  const row = await env.DB.prepare("SELECT credits FROM users WHERE id = ?")
    .bind(userId)
    .first<{ credits: number }>();
  return row?.credits ?? null;
}

describe("credit ledger invariants", () => {
  it("ledger sum tracks users.credits through signup, settlement, and admin adjustment, including a negative balance", async () => {
    const userId = crypto.randomUUID();
    await insertUser(userId, `player-${userId}`);

    // Signup grant.
    await insertLedgerEntry({
      userId,
      amount: 5000,
      gameId: null,
      reason: "signup_grant",
    });
    expect(await currentCredits(userId)).toBe(5000);
    expect(await ledgerSum(userId)).toBe(5000);

    // Game settlement large enough to drive the balance negative.
    const settlementKey = `table-${userId}`;
    await insertLedgerEntry({
      userId,
      amount: -8000,
      gameId: "doudizhu",
      reason: "game_settlement",
      idempotencyKey: settlementKey,
    });
    expect(await currentCredits(userId)).toBe(-3000);
    expect(await ledgerSum(userId)).toBe(-3000);

    // Admin adjustment.
    await insertLedgerEntry({
      userId,
      amount: 1000,
      gameId: null,
      reason: "admin_adjustment",
    });
    expect(await currentCredits(userId)).toBe(-2000);
    expect(await ledgerSum(userId)).toBe(-2000);

    // The core invariant: SUM(credit_ledger.amount) for a user always equals users.credits.
    expect(await currentCredits(userId)).toBe(await ledgerSum(userId));
  });

  it("rejects a duplicate settlement insert sharing an idempotency_key", async () => {
    const userId = crypto.randomUUID();
    await insertUser(userId, `dupe-${userId}`);
    const settlementKey = `table-${userId}`;

    await insertLedgerEntry({
      userId,
      amount: -8000,
      gameId: "doudizhu",
      reason: "game_settlement",
      idempotencyKey: settlementKey,
    });

    await expect(
      insertLedgerEntry({
        userId,
        amount: -8000,
        gameId: "doudizhu",
        reason: "game_settlement",
        idempotencyKey: settlementKey,
      }),
    ).rejects.toThrow();
  });

  it("allows multiple ledger rows with a NULL idempotency_key", async () => {
    const userId = crypto.randomUUID();
    await insertUser(userId, `nullkey-${userId}`);

    await insertLedgerEntry({ userId, amount: 5000, reason: "signup_grant" });
    await insertLedgerEntry({ userId, amount: 500, reason: "admin_adjustment" });

    expect(await ledgerSum(userId)).toBe(5500);
  });

  it("rejects a reason outside the allowed set", async () => {
    const userId = crypto.randomUUID();
    await insertUser(userId, `badreason-${userId}`);

    await expect(
      env.DB.prepare(
        "INSERT INTO credit_ledger (user_id, amount, reason) VALUES (?, ?, ?)",
      )
        .bind(userId, 100, "not_a_real_reason")
        .run(),
    ).rejects.toThrow();
  });
});

describe("users invariants", () => {
  it("enforces case-insensitive unique usernames", async () => {
    const idA = crypto.randomUUID();
    const idB = crypto.randomUUID();
    await insertUser(idA, "SameName");

    await expect(insertUser(idB, "samename")).rejects.toThrow();
  });

  it("allows a negative credits value at the row level", async () => {
    const userId = crypto.randomUUID();
    await insertUser(userId, `negative-${userId}`);
    await env.DB.prepare("UPDATE users SET credits = ? WHERE id = ?")
      .bind(-12345, userId)
      .run();

    expect(await currentCredits(userId)).toBe(-12345);
  });
});

describe("foreign key cascades", () => {
  let userId: string;

  beforeEach(async () => {
    userId = crypto.randomUUID();
    await insertUser(userId, `cascade-${userId}`);
  });

  it("deletes sessions when the owning user is deleted", async () => {
    await env.DB.prepare(
      "INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)",
    )
      .bind(crypto.randomUUID(), userId, "2099-01-01T00:00:00Z")
      .run();

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(remaining?.n ?? 0).toBe(0);
  });

  it("deletes credit_ledger rows when the owning user is deleted", async () => {
    await insertLedgerEntry({ userId, amount: 5000, reason: "signup_grant" });

    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(userId).run();

    const remaining = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM credit_ledger WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ n: number }>();
    expect(remaining?.n ?? 0).toBe(0);
  });
});

describe("games table", () => {
  it("stores a result archive keyed by table id and indexed by game_id", async () => {
    const tableId = crypto.randomUUID();
    await env.DB.prepare(
      "INSERT INTO games (id, game_id, stake, result_json) VALUES (?, ?, ?, ?)",
    )
      .bind(tableId, "doudizhu", 1000, JSON.stringify({ winner: "landlord" }))
      .run();

    const row = await env.DB.prepare("SELECT * FROM games WHERE id = ?")
      .bind(tableId)
      .first<{ game_id: string; stake: number }>();
    expect(row?.game_id).toBe("doudizhu");
    expect(row?.stake).toBe(1000);
  });
});
