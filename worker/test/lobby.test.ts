import { SELF, env, runInDurableObject } from "cloudflare:test";
import {
  RANK,
  applyAction,
  createDeck,
  createGame,
  type Action,
  type Card,
  type GameState,
  type Seat,
} from "doudizhu";
import { describe, expect, it } from "vitest";
import { lobbyDoName } from "../src/durable-objects/lobby";

const GAME_ID = "doudizhu";
const STAKE = 100;
const ADMIN_USERNAME = "admin";
const ADMIN_TEST_PASSWORD = "test-admin-password"; // matches vitest.config.ts's ADMIN_PASSWORD binding

// --- User / auth helpers, mirroring test/admin.test.ts and test/game-table.test.ts ---

function uniqueUsername(prefix: string): string {
  return `${prefix}${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;
}

function extractCookie(res: Response): string {
  const setCookie = res.headers.get("set-cookie");
  if (!setCookie) throw new Error("expected a Set-Cookie header");
  return setCookie.split(";")[0];
}

async function registerUser(prefix: string): Promise<{ id: string; username: string; cookie: string }> {
  const username = uniqueUsername(prefix);
  const res = await SELF.fetch("http://example.com/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "correct horse battery staple" }),
  });
  expect(res.status).toBe(201);
  const body = await res.json<{ id: string }>();
  return { id: body.id, username, cookie: extractCookie(res) };
}

async function loginAsAdmin(): Promise<{ cookie: string; id: string }> {
  const res = await SELF.fetch("http://example.com/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username: ADMIN_USERNAME, password: ADMIN_TEST_PASSWORD }),
  });
  expect(res.status).toBe(200);
  const body = await res.json<{ id: string }>();
  return { cookie: extractCookie(res), id: body.id };
}

async function openTableSocket(tableId: string, cookie: string): Promise<WebSocket> {
  const res = await SELF.fetch(`http://example.com/api/tables/${tableId}/ws`, {
    headers: { Upgrade: "websocket", cookie },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  if (!ws) throw new Error("server did not accept the websocket upgrade");
  ws.accept();
  return ws;
}

// --- Lobby HTTP helpers ------------------------------------------------------

function quickPlay(gameId: string, cookie: string) {
  return SELF.fetch(`http://example.com/api/lobby/${gameId}/quickplay`, {
    method: "POST",
    headers: { cookie },
  });
}

function leaveQuickPlay(gameId: string, cookie: string) {
  return SELF.fetch(`http://example.com/api/lobby/${gameId}/quickplay`, {
    method: "DELETE",
    headers: { cookie },
  });
}

function createCustomGame(gameId: string, cookie: string, body: { stake: number; inviteOnly: boolean }) {
  return SELF.fetch(`http://example.com/api/lobby/${gameId}/games`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function listOpenParties(gameId: string, cookie: string) {
  return SELF.fetch(`http://example.com/api/lobby/${gameId}/parties`, { headers: { cookie } });
}

function joinParty(gameId: string, cookie: string, tableId: string) {
  return SELF.fetch(`http://example.com/api/lobby/${gameId}/parties/${tableId}/join`, {
    method: "POST",
    headers: { cookie },
  });
}

function joinByCode(gameId: string, cookie: string, code: string) {
  return SELF.fetch(`http://example.com/api/lobby/${gameId}/join-by-code`, {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
}

/** Ages a LobbyDO table row directly in storage — no real waiting. */
async function ageTableRow(gameId: string, tableId: string, ageMs: number): Promise<void> {
  const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(gameId));
  await runInDurableObject(lobbyStub, async (_instance, doState) => {
    doState.storage.sql.exec("UPDATE tables SET created_at = ? WHERE table_id = ?", Date.now() - ageMs, tableId);
  });
}

function deleteUser(cookie: string, userId: string) {
  return SELF.fetch(`http://example.com/api/admin/users/${userId}`, {
    method: "DELETE",
    headers: { cookie },
  });
}

// --- Scripted engine replay (pure doudizhu engine, no sockets), reused to drive
// a table straight to a finished hand for the isUserInLiveGame test. Mirrors
// test/game-table.test.ts's scripted-deck pattern. ---

const LANDLORD_BOMB_RANKS = [RANK.Three, RANK.Four, RANK.Five, RANK.Six, RANK.Seven] as const;

function buildScriptedDeck(): Card[] {
  const full = createDeck();
  const isLandlordRank = (c: Card) => c.rank >= RANK.Three && c.rank <= RANK.Seven;
  const landlordCards = full.filter(isLandlordRank); // 20 cards
  const farmerCards = full.filter((c) => !isLandlordRank(c)); // 34 cards
  return [...landlordCards.slice(0, 17), ...farmerCards, ...landlordCards.slice(17, 20)];
}

function cardIdsForRank(rank: number): string[] {
  return createDeck()
    .filter((c) => c.rank === rank)
    .map((c) => c.id);
}

function applyOrThrow(state: GameState, seat: Seat, action: Action): GameState {
  const result = applyAction(state, seat, action);
  if (!result.ok) throw new Error(`unexpected rejection in replay: ${result.reason}`);
  return result.state;
}

function buildFinishedState(deck: Card[]): GameState {
  let state: GameState = createGame({ shuffledDeck: deck, firstBidder: 0, baseStake: STAKE });
  state = applyOrThrow(state, 0, { type: "bid", amount: 3 });
  for (let i = 0; i < LANDLORD_BOMB_RANKS.length; i++) {
    state = applyOrThrow(state, 0, { type: "play", cardIds: cardIdsForRank(LANDLORD_BOMB_RANKS[i]) });
    if (i < LANDLORD_BOMB_RANKS.length - 1) {
      state = applyOrThrow(state, 1, { type: "pass" });
      state = applyOrThrow(state, 2, { type: "pass" });
    }
  }
  if (state.phase !== "finished") throw new Error("expected replay to reach a finished state");
  return state;
}

/** Directly seats 3 users with an in-progress (unfinished, unsettled) hand on `tableId`, bypassing WS play. */
async function seatWithUnfinishedHand(
  tableId: string,
  users: readonly [{ id: string; username: string }, { id: string; username: string }, { id: string; username: string }],
): Promise<void> {
  const stub = env.GAME_TABLE_DO.getByName(tableId);
  const state = createGame({ shuffledDeck: buildScriptedDeck(), firstBidder: 0, baseStake: STAKE });
  await runInDurableObject(stub, async (_instance, doState) => {
    for (let seat = 0; seat < 3; seat++) {
      doState.storage.sql.exec(
        "INSERT INTO seats (seat, user_id, username, ready) VALUES (?, ?, ?, 1)",
        seat,
        users[seat].id,
        users[seat].username,
      );
    }
    doState.storage.sql.exec(
      "UPDATE game_state SET state_json = ?, settled = 0 WHERE id = 1",
      JSON.stringify(state),
    );
  });
}

/**
 * Polls `check` until it resolves true or `timeoutMs` elapses. Used only to
 * observe the Durable Object side finishing its own asynchronous close
 * handling after a client-side `ws.close()` — there's no other socket left
 * on an all-tabs-closed table to synchronize on via a broadcast frame, so a
 * bounded poll (not a blind fixed sleep) is the deterministic option here.
 */
async function waitUntil(check: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** Directly seats 3 users and force-finishes+settles a hand on `tableId`, bypassing WS play. */
async function seatAndSettle(
  tableId: string,
  users: readonly [{ id: string; username: string }, { id: string; username: string }, { id: string; username: string }],
): Promise<void> {
  const stub = env.GAME_TABLE_DO.getByName(tableId);
  const finished = buildFinishedState(buildScriptedDeck());
  await runInDurableObject(stub, async (_instance, doState) => {
    for (let seat = 0; seat < 3; seat++) {
      doState.storage.sql.exec(
        "INSERT INTO seats (seat, user_id, username, ready) VALUES (?, ?, ?, 1)",
        seat,
        users[seat].id,
        users[seat].username,
      );
    }
    doState.storage.sql.exec(
      "UPDATE game_state SET state_json = ?, settled = 0 WHERE id = 1",
      JSON.stringify(finished),
    );
  });
  await stub.forceSettle();
}

// --- Tests --------------------------------------------------------------------

describe("lobby routes — unknown game", () => {
  it("404s on every route for a gameId not in the registry", async () => {
    const user = await registerUser("unk");
    expect((await quickPlay("chess", user.cookie)).status).toBe(404);
    expect((await listOpenParties("chess", user.cookie)).status).toBe(404);
    expect((await createCustomGame("chess", user.cookie, { stake: 100, inviteOnly: false })).status).toBe(404);
  });
});

describe("quick play", () => {
  it("matches exactly 3 distinct users into the same table, is idempotent per user, and lets all 3 connect", async () => {
    const [p1, p2, p3] = await Promise.all([
      registerUser("qp1"),
      registerUser("qp2"),
      registerUser("qp3"),
    ]);

    const first = await quickPlay(GAME_ID, p1.cookie);
    expect(first.status).toBe(200);
    expect((await first.json<{ status: string }>()).status).toBe("queued");

    // Duplicate call from the same user must not add a second queue slot.
    const dupe = await quickPlay(GAME_ID, p1.cookie);
    expect((await dupe.json<{ status: string }>()).status).toBe("queued");

    const secondUserRes = await quickPlay(GAME_ID, p2.cookie);
    // If p1's duplicate had double-counted, the queue would already be at 3
    // here and this would come back "matched" instead.
    expect((await secondUserRes.json<{ status: string }>()).status).toBe("queued");

    const thirdUserRes = await quickPlay(GAME_ID, p3.cookie);
    expect(thirdUserRes.status).toBe(200);
    const thirdBody = await thirdUserRes.json<{ status: string; tableId?: string }>();
    expect(thirdBody.status).toBe("matched");
    expect(thirdBody.tableId).toBeTruthy();
    const tableId = thirdBody.tableId!;

    // Earlier joiners learn their table by polling again.
    const p1Poll = await (await quickPlay(GAME_ID, p1.cookie)).json<{ status: string; tableId?: string }>();
    expect(p1Poll).toEqual({ status: "matched", tableId });
    const p2Poll = await (await quickPlay(GAME_ID, p2.cookie)).json<{ status: string; tableId?: string }>();
    expect(p2Poll).toEqual({ status: "matched", tableId });

    const sockets = await Promise.all(
      [p1.cookie, p2.cookie, p3.cookie].map((cookie) => openTableSocket(tableId, cookie)),
    );
    for (const ws of sockets) ws.close();
  });

  it("DELETE dequeues a user so a later match doesn't include them", async () => {
    const user = await registerUser("qpleave");
    expect((await (await quickPlay(GAME_ID, user.cookie)).json<{ status: string }>()).status).toBe(
      "queued",
    );

    const leaveRes = await leaveQuickPlay(GAME_ID, user.cookie);
    expect(leaveRes.status).toBe(200);

    // Re-polling after leaving starts a fresh queue slot, not a stale match.
    const rejoin = await (await quickPlay(GAME_ID, user.cookie)).json<{ status: string }>();
    expect(rejoin.status).toBe("queued");
    await leaveQuickPlay(GAME_ID, user.cookie);
  });
});

describe("custom games — invite code", () => {
  it("joins by correct code and 404s on a wrong one", async () => {
    const [host, joiner] = await Promise.all([registerUser("cghost"), registerUser("cgjoin")]);

    const createRes = await createCustomGame(GAME_ID, host.cookie, { stake: 250, inviteOnly: true });
    expect(createRes.status).toBe(200);
    const created = await createRes.json<{ tableId: string; inviteCode?: string }>();
    expect(created.inviteCode).toMatch(/^[A-Z0-9]{6}$/);

    const wrongRes = await joinByCode(GAME_ID, joiner.cookie, "ZZZZZZ");
    expect(wrongRes.status).toBe(404);

    const rightRes = await joinByCode(GAME_ID, joiner.cookie, created.inviteCode!);
    expect(rightRes.status).toBe(200);
    expect(await rightRes.json<{ tableId: string }>()).toEqual({ tableId: created.tableId });

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    expect(await lobbyStub.isMember(joiner.id)).toBe(true);

    const sockets = await Promise.all(
      [host.cookie, joiner.cookie].map((cookie) => openTableSocket(created.tableId, cookie)),
    );
    for (const ws of sockets) ws.close();
  });
});

describe("public directory", () => {
  it("lists a public table, hides a private one, and hides a full one", async () => {
    const [host, other] = await Promise.all([registerUser("pubhost"), registerUser("pubother")]);

    const publicRes = await createCustomGame(GAME_ID, host.cookie, { stake: 150, inviteOnly: false });
    const publicTable = await publicRes.json<{ tableId: string }>();

    const privateRes = await createCustomGame(GAME_ID, host.cookie, { stake: 150, inviteOnly: true });
    const privateTable = await privateRes.json<{ tableId: string }>();

    const before = await (await listOpenParties(GAME_ID, host.cookie)).json<
      Array<{ tableId: string; hostUsername: string; stake: number; seatsFilled: number; seatsTotal: number; createdAt: string }>
    >();
    const listedPublic = before.find((p) => p.tableId === publicTable.tableId);
    expect(listedPublic).toBeDefined();
    expect(listedPublic).toMatchObject({
      hostUsername: host.username,
      stake: 150,
      seatsFilled: 1,
      seatsTotal: 3,
    });
    expect(new Date(listedPublic!.createdAt).toString()).not.toBe("Invalid Date");
    expect(before.some((p) => p.tableId === privateTable.tableId)).toBe(false);

    // Fill the public table via 3 real WS connections.
    const [p2, p3] = await Promise.all([registerUser("pubp2"), registerUser("pubp3")]);
    const sockets = await Promise.all(
      [host.cookie, p2.cookie, p3.cookie].map((cookie) => openTableSocket(publicTable.tableId, cookie)),
    );

    const afterFull = await (await listOpenParties(GAME_ID, host.cookie)).json<Array<{ tableId: string }>>();
    expect(afterFull.some((p) => p.tableId === publicTable.tableId)).toBe(false);

    const joinFullRes = await joinParty(GAME_ID, other.cookie, publicTable.tableId);
    expect(joinFullRes.status).toBe(409);

    for (const ws of sockets) ws.close();
  });

  it("joinParty records membership and is idempotent for the same user", async () => {
    const [host, joiner] = await Promise.all([registerUser("jphost"), registerUser("jpjoiner")]);
    const created = await (
      await createCustomGame(GAME_ID, host.cookie, { stake: 100, inviteOnly: false })
    ).json<{ tableId: string }>();

    const joinRes = await joinParty(GAME_ID, joiner.cookie, created.tableId);
    expect(joinRes.status).toBe(200);
    expect(await joinRes.json<{ tableId: string }>()).toEqual({ tableId: created.tableId });

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    expect(await lobbyStub.isMember(joiner.id)).toBe(true);

    const listed = await (await listOpenParties(GAME_ID, host.cookie)).json<
      Array<{ tableId: string; seatsFilled: number }>
    >();
    expect(listed.find((p) => p.tableId === created.tableId)?.seatsFilled).toBe(2);

    // Re-joining the same table must not consume a second reservation slot.
    const rejoinRes = await joinParty(GAME_ID, joiner.cookie, created.tableId);
    expect(rejoinRes.status).toBe(200);
    const listedAfterRejoin = await (await listOpenParties(GAME_ID, host.cookie)).json<
      Array<{ tableId: string; seatsFilled: number }>
    >();
    expect(listedAfterRejoin.find((p) => p.tableId === created.tableId)?.seatsFilled).toBe(2);
  });

  it("joinParty rejects a table id that isn't a public listing (e.g. a private table)", async () => {
    const [host, joiner] = await Promise.all([registerUser("jpprivh"), registerUser("jpprivj")]);
    const created = await (
      await createCustomGame(GAME_ID, host.cookie, { stake: 100, inviteOnly: true })
    ).json<{ tableId: string }>();

    const res = await joinParty(GAME_ID, joiner.cookie, created.tableId);
    expect(res.status).toBe(404);
  });
});

describe("open parties — inactive table cleanup", () => {
  it("still lists a freshly created public table with no sockets yet (within the grace window)", async () => {
    const host = await registerUser("freshtbl");
    const created = await (
      await createCustomGame(GAME_ID, host.cookie, { stake: 100, inviteOnly: false })
    ).json<{ tableId: string }>();

    const listed = await (await listOpenParties(GAME_ID, host.cookie)).json<Array<{ tableId: string }>>();
    expect(listed.some((p) => p.tableId === created.tableId)).toBe(true);
  });

  it("drops and clears a never-connected public table once it's older than the inactivity grace", async () => {
    const host = await registerUser("inactold");
    const created = await (
      await createCustomGame(GAME_ID, host.cookie, { stake: 100, inviteOnly: false })
    ).json<{ tableId: string }>();

    // Past the 2-minute grace, and nobody ever opened a socket — this is the
    // abandoned-host-navigated-away scenario the fix targets.
    await ageTableRow(GAME_ID, created.tableId, 3 * 60 * 1000);

    const listed = await (await listOpenParties(GAME_ID, host.cookie)).json<Array<{ tableId: string }>>();
    expect(listed.some((p) => p.tableId === created.tableId)).toBe(false);

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    await runInDurableObject(lobbyStub, async (_instance, doState) => {
      expect(
        doState.storage.sql.exec("SELECT 1 FROM tables WHERE table_id = ?", created.tableId).toArray(),
      ).toHaveLength(0);
      expect(
        doState.storage.sql.exec("SELECT 1 FROM membership WHERE table_id = ?", created.tableId).toArray(),
      ).toHaveLength(0);
      expect(
        doState.storage.sql.exec("SELECT 1 FROM invite_codes WHERE table_id = ?", created.tableId).toArray(),
      ).toHaveLength(0);
    });
  });

  it("lists a public table with a connected socket regardless of its age", async () => {
    const host = await registerUser("oldconn");
    const created = await (
      await createCustomGame(GAME_ID, host.cookie, { stake: 100, inviteOnly: false })
    ).json<{ tableId: string }>();

    const ws = await openTableSocket(created.tableId, host.cookie);
    await ageTableRow(GAME_ID, created.tableId, 60 * 60 * 1000); // 1h old, well past the grace

    const listed = await (await listOpenParties(GAME_ID, host.cookie)).json<Array<{ tableId: string }>>();
    expect(listed.some((p) => p.tableId === created.tableId)).toBe(true);

    ws.close();
  });

  it("drops and clears a table whose hand already concluded, even if the lobby was never notified", async () => {
    const host = await registerUser("stalefin");
    const created = await (
      await createCustomGame(GAME_ID, host.cookie, { stake: 100, inviteOnly: false })
    ).json<{ tableId: string }>();

    // Simulate a settle/abort notify that raced or failed to reach the
    // lobby: mark the table's own game_state as settled directly, bypassing
    // forceSettle (which itself calls notifySettled and would clear this row
    // through the normal path, defeating the point of this test).
    const tableStub = env.GAME_TABLE_DO.getByName(created.tableId);
    await runInDurableObject(tableStub, async (_instance, doState) => {
      doState.storage.sql.exec("UPDATE game_state SET settled = 1 WHERE id = 1");
    });

    const listed = await (await listOpenParties(GAME_ID, host.cookie)).json<Array<{ tableId: string }>>();
    expect(listed.some((p) => p.tableId === created.tableId)).toBe(false);

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    await runInDurableObject(lobbyStub, async (_instance, doState) => {
      expect(
        doState.storage.sql.exec("SELECT 1 FROM tables WHERE table_id = ?", created.tableId).toArray(),
      ).toHaveLength(0);
    });
  });
});

describe("isUserInLiveGame + admin delete-user integration", () => {
  it("does not block deleting a matched user nobody ever connected to (never-started table)", async () => {
    const admin = await loginAsAdmin();
    const [p1, p2, p3] = await Promise.all([
      registerUser("nolive1"),
      registerUser("nolive2"),
      registerUser("nolive3"),
    ]);

    await quickPlay(GAME_ID, p1.cookie);
    await quickPlay(GAME_ID, p2.cookie);
    await quickPlay(GAME_ID, p3.cookie);

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    // Raw membership was recorded by the match...
    expect(await lobbyStub.isMember(p2.id)).toBe(true);
    // ...but nobody ever opened a socket, so the table isn't "live" — a hand
    // that never started can't be disrupted by deleting one of its members.
    const res = await deleteUser(admin.cookie, p2.id);
    expect(res.status).toBe(200);
  });

  it("blocks deleting a user connected mid-hand, then allows it once every socket disconnects — and self-heals the stale lobby rows", async () => {
    const admin = await loginAsAdmin();
    const [p1, p2, p3] = await Promise.all([
      registerUser("live1"),
      registerUser("live2"),
      registerUser("live3"),
    ]);

    await quickPlay(GAME_ID, p1.cookie);
    await quickPlay(GAME_ID, p2.cookie);
    const matchRes = await quickPlay(GAME_ID, p3.cookie);
    const { tableId } = await matchRes.json<{ tableId: string }>();

    await seatWithUnfinishedHand(tableId, [
      { id: p1.id, username: p1.username },
      { id: p2.id, username: p2.username },
      { id: p3.id, username: p3.username },
    ]);
    const sockets = await Promise.all(
      [p1.cookie, p2.cookie, p3.cookie].map((cookie) => openTableSocket(tableId, cookie)),
    );

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    expect(await lobbyStub.isMember(p2.id)).toBe(true);

    const blockedRes = await deleteUser(admin.cookie, p2.id);
    expect(blockedRes.status).toBe(409);

    // Every tab closes — nobody ever finishes or settles the hand. This is
    // the abandoned-table scenario the fix targets: the old membership-only
    // check would have blocked deletion forever.
    for (const ws of sockets) ws.close();
    const tableStub = env.GAME_TABLE_DO.getByName(tableId);
    await waitUntil(async () => (await tableStub.getLiveness()).anyConnected === false);

    const allowedRes = await deleteUser(admin.cookie, p2.id);
    expect(allowedRes.status).toBe(200);

    // Self-heal: the abandoned table's lobby bookkeeping is actually cleared
    // (not just bypassed) — checked directly against LobbyDO's own storage
    // rather than only through isMember, so a stale `tables`/`invite_codes`
    // row wouldn't be missed.
    expect(await lobbyStub.isMember(p1.id)).toBe(false);
    expect(await lobbyStub.isMember(p3.id)).toBe(false);
    await runInDurableObject(lobbyStub, async (_instance, doState) => {
      expect(doState.storage.sql.exec("SELECT 1 FROM membership WHERE table_id = ?", tableId).toArray()).toHaveLength(0);
      expect(doState.storage.sql.exec("SELECT 1 FROM tables WHERE table_id = ?", tableId).toArray()).toHaveLength(0);
      expect(doState.storage.sql.exec("SELECT 1 FROM invite_codes WHERE table_id = ?", tableId).toArray()).toHaveLength(0);
    });
  });

  it("still blocks deleting a user who stays connected while their opponents' tabs close (not abandoned for them)", async () => {
    const admin = await loginAsAdmin();
    const [p1, p2, p3] = await Promise.all([
      registerUser("stay1"),
      registerUser("stay2"),
      registerUser("stay3"),
    ]);

    await quickPlay(GAME_ID, p1.cookie);
    await quickPlay(GAME_ID, p2.cookie);
    const matchRes = await quickPlay(GAME_ID, p3.cookie);
    const { tableId } = await matchRes.json<{ tableId: string }>();

    await seatWithUnfinishedHand(tableId, [
      { id: p1.id, username: p1.username },
      { id: p2.id, username: p2.username },
      { id: p3.id, username: p3.username },
    ]);

    const s1 = await openTableSocket(tableId, p1.cookie);
    const s2 = await openTableSocket(tableId, p2.cookie);
    const s3 = await openTableSocket(tableId, p3.cookie);
    s1.close();
    s3.close();

    // p2's own socket never closes, so the table stays live for them
    // regardless of how quickly the other two disconnects are processed.
    const res = await deleteUser(admin.cookie, p2.id);
    expect(res.status).toBe(409);

    s2.close();
  });

  it("still allows deleting a user once their hand settles normally", async () => {
    const admin = await loginAsAdmin();
    const [p1, p2, p3] = await Promise.all([
      registerUser("settle1"),
      registerUser("settle2"),
      registerUser("settle3"),
    ]);

    await quickPlay(GAME_ID, p1.cookie);
    await quickPlay(GAME_ID, p2.cookie);
    const matchRes = await quickPlay(GAME_ID, p3.cookie);
    const { tableId } = await matchRes.json<{ tableId: string }>();

    const lobbyStub = env.LOBBY_DO.getByName(lobbyDoName(GAME_ID));
    expect(await lobbyStub.isMember(p2.id)).toBe(true);

    await seatAndSettle(tableId, [
      { id: p1.id, username: p1.username },
      { id: p2.id, username: p2.username },
      { id: p3.id, username: p3.username },
    ]);

    expect(await lobbyStub.isMember(p2.id)).toBe(false);

    const allowedRes = await deleteUser(admin.cookie, p2.id);
    expect(allowedRes.status).toBe(200);
  });
});
