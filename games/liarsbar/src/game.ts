import type { Card, TableRank } from "./cards";
import { SEATS, dealHands, nextAliveSeat, nextAliveSeatWithCards, type Seat } from "./deal";

export type Action = { type: "play"; cardIds: readonly string[] } | { type: "challenge" };

/** One entry in a round's play history log. Counts + claimant only — never card identities. */
export interface PlayRecord {
  readonly seat: Seat;
  readonly cardCount: number;
}

/** A pending face-down play: real cards are known to the engine but hidden from every view until challenged. */
export interface LastPlay {
  readonly seat: Seat;
  readonly cards: readonly Card[];
}

/** Full status of one seat, including the secret bullet chamber. Never exposed whole through viewFor. */
export interface PlayerStatus {
  readonly alive: boolean;
  /** Fixed at game creation, never changes across rounds. Never appears in any redacted view. */
  readonly bulletChamber: number;
  /** Times this seat has spun the chamber. Persists across rounds. Public. */
  readonly pulls: number;
}

/** The reveal produced by resolving a challenge (explicit or auto). Fully public once produced. */
export interface RevealRecord {
  readonly playSeat: Seat;
  readonly challengerSeat: Seat;
  readonly cards: readonly Card[];
  readonly wasTruthful: boolean;
  readonly loserSeat: Seat;
  /** True when nobody explicitly called "liar" — the engine forced the reveal because no other
   * alive player could ever hold cards to challenge with (see the auto-challenge rule below). */
  readonly auto: boolean;
}

export interface PlayingState {
  readonly phase: "playing";
  /** Seats playing this game, fixed at createGame. Absent seats are never alive,
   * never dealt to, and settle at 0. Missing (older persisted state) means all four. */
  readonly activeSeats?: readonly Seat[];
  readonly baseStake: number;
  readonly tableRank: TableRank;
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  readonly players: Readonly<Record<Seat, PlayerStatus>>;
  readonly currentTurn: Seat;
  /** The play the current turn may challenge; null means nothing is pending (a free lead). */
  readonly lastPlay: LastPlay | null;
  readonly history: readonly PlayRecord[];
}

/** A challenge has just resolved and >1 player remains alive; caller must shuffle a fresh
 * deck + pick a table rank and call startNextRound. Mirrors doudizhu's "redeal" signal state. */
export interface RoundEndState {
  readonly phase: "roundEnd";
  /** See PlayingState.activeSeats. */
  readonly activeSeats?: readonly Seat[];
  readonly baseStake: number;
  readonly players: Readonly<Record<Seat, PlayerStatus>>;
  readonly lastReveal: RevealRecord;
  /** Who leads the next round: the challenge loser if they survived, else the next alive seat after them. */
  readonly nextFirstSeat: Seat;
}

export interface FinishedState {
  readonly phase: "finished";
  /** See PlayingState.activeSeats. */
  readonly activeSeats?: readonly Seat[];
  readonly baseStake: number;
  readonly winner: Seat;
  readonly players: Readonly<Record<Seat, PlayerStatus>>;
  readonly lastReveal: RevealRecord;
}

export type GameState = PlayingState | RoundEndState | FinishedState;

export type RejectionReason =
  | "wrong-phase"
  | "not-your-turn"
  | "empty-play"
  | "too-many-cards"
  | "invalid-cards"
  | "cards-not-in-hand"
  | "nothing-to-challenge";

export type ApplyResult = { ok: true; state: GameState } | { ok: false; reason: RejectionReason };

export interface CreateGameOptions {
  /** Exactly 20 cards, already shuffled by the caller (see shuffleDeck / createSeededRandom). */
  readonly shuffledDeck: readonly Card[];
  /** Chosen by the caller (see pickTableRank), not by the engine. */
  readonly tableRank: TableRank;
  /** One entry per seat, each an integer 1-6 (see rollBulletChamber). Fixed for the whole game. */
  readonly bulletPositions: Readonly<Record<Seat, number>>;
  /** Seat that leads the first round; the caller decides this. Must be active. */
  readonly firstSeat: Seat;
  /** 2-4 distinct seats taking part; omitted means all four. */
  readonly activeSeats?: readonly Seat[];
  readonly baseStake: number;
}

function validateActiveSeats(activeSeats: readonly Seat[]): readonly Seat[] {
  const unique = [...new Set(activeSeats)].sort((a, b) => a - b);
  if (unique.length !== activeSeats.length || unique.some((s) => !SEATS.includes(s))) {
    throw new Error(`activeSeats must be distinct seats 0-3, got ${JSON.stringify(activeSeats)}`);
  }
  if (unique.length < 2) {
    throw new Error(`activeSeats needs at least 2 seats, got ${unique.length}`);
  }
  return unique;
}

function validateBulletPositions(bulletPositions: Readonly<Record<Seat, number>>): void {
  for (const seat of SEATS) {
    const value = bulletPositions[seat];
    if (!Number.isInteger(value) || value < 1 || value > 6) {
      throw new Error(`bulletPositions[${seat}] must be an integer 1-6, got ${String(value)}`);
    }
  }
}

export function createGame(options: CreateGameOptions): PlayingState {
  validateBulletPositions(options.bulletPositions);
  const activeSeats = validateActiveSeats(options.activeSeats ?? SEATS);
  if (!activeSeats.includes(options.firstSeat)) {
    throw new Error(`firstSeat ${options.firstSeat} is not in activeSeats`);
  }
  const active = new Set(activeSeats);
  const players: Record<Seat, PlayerStatus> = {
    0: { alive: active.has(0), pulls: 0, bulletChamber: options.bulletPositions[0] },
    1: { alive: active.has(1), pulls: 0, bulletChamber: options.bulletPositions[1] },
    2: { alive: active.has(2), pulls: 0, bulletChamber: options.bulletPositions[2] },
    3: { alive: active.has(3), pulls: 0, bulletChamber: options.bulletPositions[3] },
  };
  const hands = dealHands(options.shuffledDeck, activeSeats);
  return {
    phase: "playing",
    activeSeats,
    baseStake: options.baseStake,
    tableRank: options.tableRank,
    hands,
    players,
    currentTurn: options.firstSeat,
    lastPlay: null,
    history: [],
  };
}

export interface StartNextRoundOptions {
  /** Exactly 20 cards, freshly shuffled by the caller. */
  readonly shuffledDeck: readonly Card[];
  /** Chosen by the caller for the new round. */
  readonly tableRank: TableRank;
}

/** Advance a roundEnd signal into a fresh playing round. Not a player action (no seat/rejection),
 * matching how the caller drives doudizhu's redeal by calling createGame again — except here
 * players/pulls/alive/bulletChamber must carry forward, so this is a distinct function rather
 * than a second call to createGame. */
export function startNextRound(state: RoundEndState, options: StartNextRoundOptions): PlayingState {
  const aliveSeats = SEATS.filter((seat) => state.players[seat].alive);
  const hands = dealHands(options.shuffledDeck, aliveSeats);
  return {
    phase: "playing",
    activeSeats: state.activeSeats,
    baseStake: state.baseStake,
    tableRank: options.tableRank,
    hands,
    players: state.players,
    currentTurn: state.nextFirstSeat,
    lastPlay: null,
    history: [],
  };
}

export function applyAction(state: GameState, seat: Seat, action: Action): ApplyResult {
  if (state.phase !== "playing") return { ok: false, reason: "wrong-phase" };
  if (seat !== state.currentTurn) return { ok: false, reason: "not-your-turn" };
  if (action.type === "challenge") return applyChallenge(state, seat);
  return applyPlay(state, seat, action);
}

function applyChallenge(state: PlayingState, seat: Seat): ApplyResult {
  if (state.lastPlay === null) return { ok: false, reason: "nothing-to-challenge" };
  return { ok: true, state: resolveChallenge(state, seat, false) };
}

function withHand(
  hands: Readonly<Record<Seat, readonly Card[]>>,
  seat: Seat,
  newHand: readonly Card[],
): Record<Seat, readonly Card[]> {
  return {
    0: seat === 0 ? newHand : hands[0],
    1: seat === 1 ? newHand : hands[1],
    2: seat === 2 ? newHand : hands[2],
    3: seat === 3 ? newHand : hands[3],
  };
}

function withPlayerStatus(
  players: Readonly<Record<Seat, PlayerStatus>>,
  seat: Seat,
  newStatus: PlayerStatus,
): Record<Seat, PlayerStatus> {
  return {
    0: seat === 0 ? newStatus : players[0],
    1: seat === 1 ? newStatus : players[1],
    2: seat === 2 ? newStatus : players[2],
    3: seat === 3 ? newStatus : players[3],
  };
}

function applyPlay(state: PlayingState, seat: Seat, action: Extract<Action, { type: "play" }>): ApplyResult {
  if (action.cardIds.length === 0) return { ok: false, reason: "empty-play" };
  if (action.cardIds.length > 3) return { ok: false, reason: "too-many-cards" };
  if (new Set(action.cardIds).size !== action.cardIds.length) return { ok: false, reason: "invalid-cards" };

  const hand = state.hands[seat];
  const cards: Card[] = [];
  for (const id of action.cardIds) {
    const card = hand.find((c) => c.id === id);
    if (!card) return { ok: false, reason: "cards-not-in-hand" };
    cards.push(card);
  }

  const playedIds = new Set(action.cardIds);
  const remainingHand = hand.filter((c) => !playedIds.has(c.id));
  const hands = withHand(state.hands, seat, remainingHand);
  const history = [...state.history, { seat, cardCount: cards.length }];
  const lastPlay: LastPlay = { seat, cards };
  const played: PlayingState = { ...state, hands, history, lastPlay };

  // Forced-reveal / auto-challenge rule: a player with no cards is always
  // skipped rather than given a real turn (see the loop below), so the round
  // could otherwise deadlock the moment every OTHER alive player has emptied
  // their hand — nobody would ever be left able to challenge again. The
  // natural resolution: the instant that state is reached, the last play is
  // auto-challenged by the next alive seat, exactly as if they had called
  // "liar" themselves (they bear the same risk of being wrong).
  const othersWithCards = SEATS.filter((s) => s !== seat && state.players[s].alive && hands[s].length > 0);
  if (othersWithCards.length === 0) {
    const autoChallenger = nextAliveSeat(state.players, seat);
    return { ok: true, state: resolveChallenge(played, autoChallenger, true) };
  }

  const nextTurn = nextAliveSeatWithCards(hands, state.players, seat);
  return { ok: true, state: { ...played, currentTurn: nextTurn } };
}

/**
 * Resolve a pending challenge (explicit or auto) into the next signal state.
 * Jokers are wild: a play is truthful iff every revealed card is either the
 * table rank or a joker. The loser (challenger if truthful, the original
 * player if not) spins: their pull counter increments, and they die exactly
 * when it now equals their fixed bullet chamber.
 */
function resolveChallenge(state: PlayingState, challengerSeat: Seat, auto: boolean): RoundEndState | FinishedState {
  const lastPlay = state.lastPlay;
  if (lastPlay === null) throw new Error("resolveChallenge: no pending play to resolve");

  const wasTruthful = lastPlay.cards.every((c) => c.rank === state.tableRank || c.rank === "JOKER");
  const loserSeat = wasTruthful ? challengerSeat : lastPlay.seat;

  const before = state.players[loserSeat];
  const pulls = before.pulls + 1;
  const died = pulls === before.bulletChamber;
  const players = withPlayerStatus(state.players, loserSeat, { ...before, pulls, alive: !died });

  const lastReveal: RevealRecord = {
    playSeat: lastPlay.seat,
    challengerSeat,
    cards: lastPlay.cards,
    wasTruthful,
    loserSeat,
    auto,
  };

  const aliveSeats = SEATS.filter((s) => players[s].alive);
  if (aliveSeats.length === 1) {
    return {
      phase: "finished",
      activeSeats: state.activeSeats,
      baseStake: state.baseStake,
      winner: aliveSeats[0],
      players,
      lastReveal,
    };
  }

  const nextFirstSeat = died ? nextAliveSeat(players, loserSeat) : loserSeat;
  return {
    phase: "roundEnd",
    activeSeats: state.activeSeats,
    baseStake: state.baseStake,
    players,
    lastReveal,
    nextFirstSeat,
  };
}

// --- Redacted per-seat views -------------------------------------------------

export interface PublicPlayerStatus {
  readonly alive: boolean;
  readonly pulls: number;
}

/** Rebuilt field-by-field (never spread) so a secret bulletChamber can never leak through. */
function publicPlayers(players: Readonly<Record<Seat, PlayerStatus>>): Record<Seat, PublicPlayerStatus> {
  return {
    0: { alive: players[0].alive, pulls: players[0].pulls },
    1: { alive: players[1].alive, pulls: players[1].pulls },
    2: { alive: players[2].alive, pulls: players[2].pulls },
    3: { alive: players[3].alive, pulls: players[3].pulls },
  };
}

function handCountsOf(hands: Readonly<Record<Seat, readonly Card[]>>): Record<Seat, number> {
  return { 0: hands[0].length, 1: hands[1].length, 2: hands[2].length, 3: hands[3].length };
}

export interface RedactedPlayingView {
  readonly phase: "playing";
  readonly viewer: Seat;
  /** Seats in this game; a seated user outside it is waiting for the next one. */
  readonly activeSeats: readonly Seat[];
  readonly hand: readonly Card[];
  readonly handCounts: Readonly<Record<Seat, number>>;
  readonly tableRank: TableRank;
  readonly players: Readonly<Record<Seat, PublicPlayerStatus>>;
  readonly currentTurn: Seat;
  /** Count + claimant only — the actual cards stay hidden until a challenge resolves them. */
  readonly lastPlay: { readonly seat: Seat; readonly cardCount: number } | null;
  readonly history: readonly PlayRecord[];
  readonly baseStake: number;
}

export interface RedactedRoundEndView {
  readonly phase: "roundEnd";
  readonly viewer: Seat;
  readonly activeSeats: readonly Seat[];
  readonly baseStake: number;
  readonly players: Readonly<Record<Seat, PublicPlayerStatus>>;
  /** Fully revealed now — a resolved challenge's cards are public to everyone. */
  readonly lastReveal: RevealRecord;
  readonly nextFirstSeat: Seat;
}

export interface RedactedFinishedView {
  readonly phase: "finished";
  readonly viewer: Seat;
  readonly activeSeats: readonly Seat[];
  readonly baseStake: number;
  readonly winner: Seat;
  readonly players: Readonly<Record<Seat, PublicPlayerStatus>>;
  readonly lastReveal: RevealRecord;
}

export type RedactedView = RedactedPlayingView | RedactedRoundEndView | RedactedFinishedView;

/** Per-seat view: own hand in full, opponents' hands as counts, bullet chambers never included. */
export function viewFor(state: GameState, viewer: Seat): RedactedView {
  const players = publicPlayers(state.players);
  const activeSeats = state.activeSeats ?? SEATS;

  if (state.phase === "playing") {
    return {
      phase: "playing",
      viewer,
      activeSeats,
      hand: state.hands[viewer],
      handCounts: handCountsOf(state.hands),
      tableRank: state.tableRank,
      players,
      currentTurn: state.currentTurn,
      lastPlay: state.lastPlay ? { seat: state.lastPlay.seat, cardCount: state.lastPlay.cards.length } : null,
      history: state.history,
      baseStake: state.baseStake,
    };
  }

  if (state.phase === "roundEnd") {
    return {
      phase: "roundEnd",
      viewer,
      activeSeats,
      baseStake: state.baseStake,
      players,
      lastReveal: state.lastReveal,
      nextFirstSeat: state.nextFirstSeat,
    };
  }

  return {
    phase: "finished",
    viewer,
    activeSeats,
    baseStake: state.baseStake,
    winner: state.winner,
    players,
    lastReveal: state.lastReveal,
  };
}

// --- Settlement ---------------------------------------------------------------

export type SeatDeltas = Readonly<Record<Seat, number>>;

/**
 * Zero-sum: each eliminated active seat loses baseStake, and the winner gains
 * eliminatedCount x baseStake. Absent seats (not in activeSeats) settle at 0.
 * Stake is read from `state` (set once at createGame) rather than taken as a
 * parameter, so a caller can't mis-pay by passing a mismatched value —
 * mirrors doudizhu's settle(FinishedState).
 *
 * In a real, engine-produced FinishedState the winner is always the sole
 * alive active seat and eliminatedCount is always activeSeats.length - 1 (a
 * game can only end once exactly one player remains). The formula is still
 * written to stay zero-sum for any eliminatedCount, giving any
 * alive-but-not-the-winner seat a 0 delta — a branch that's inert for every
 * reachable state, but keeps the function correct in isolation (see
 * settle.test.ts's 1/2/3-elimination cases).
 */
export function settle(state: FinishedState): SeatDeltas {
  const active = state.activeSeats ?? SEATS;
  const eliminatedCount = active.filter((s) => !state.players[s].alive).length;
  const winnerDelta = eliminatedCount * state.baseStake;
  const deltaFor = (seat: Seat): number => {
    if (!active.includes(seat)) return 0;
    if (seat === state.winner) return winnerDelta;
    return state.players[seat].alive ? 0 : -state.baseStake;
  };
  return { 0: deltaFor(0), 1: deltaFor(1), 2: deltaFor(2), 3: deltaFor(3) };
}
