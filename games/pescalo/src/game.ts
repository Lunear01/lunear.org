import { RANKS, type Card, type Rank } from "./cards";

export type Seat = 0 | 1 | 2 | 3 | 4;
export const SEATS: readonly Seat[] = [0, 1, 2, 3, 4];
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 5;
/** Books in a 52-card deck; the hand ends when all are made. */
export const BOOK_COUNT = 13;

/** 7 cards each at two seats, 5 at three or more. */
export function handSizeFor(players: number): number {
  return players === 2 ? 7 : 5;
}

export type Action = { type: "ask"; target: Seat; rank: number };

/** Public narration of the last action, in order. Reset on every action. */
export type GameEvent =
  | { readonly type: "asked"; readonly seat: Seat; readonly target: Seat; readonly rank: Rank }
  | { readonly type: "hit"; readonly seat: Seat; readonly target: Seat; readonly rank: Rank; readonly count: number }
  | { readonly type: "go-fish"; readonly seat: Seat; readonly target: Seat; readonly rank: Rank }
  /** The drawn card was the asked rank; it is shown and the seat goes again. */
  | { readonly type: "drew-match"; readonly seat: Seat; readonly rank: Rank }
  /** The drawn card stays hidden. */
  | { readonly type: "drew-hidden"; readonly seat: Seat }
  | { readonly type: "book"; readonly seat: Seat; readonly rank: Rank }
  /** An empty-handed seat drew one pool card at the start of its turn. */
  | { readonly type: "refill"; readonly seat: Seat }
  /** Empty hand and empty pool: the seat cannot act this round. */
  | { readonly type: "skipped"; readonly seat: Seat };

export type Books = Readonly<Record<Seat, readonly Rank[]>>;

export interface PlayingState {
  readonly phase: "playing";
  /** 2-5 seats dealt in, ascending. Other seats hold nothing and settle at 0. */
  readonly activeSeats: readonly Seat[];
  readonly baseStake: number;
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  /** Draw pool; the top is the last element. */
  readonly pool: readonly Card[];
  /** Ranks booked by each seat, in the order made. */
  readonly books: Books;
  readonly currentTurn: Seat;
  readonly lastEvents: readonly GameEvent[];
}

export interface FinishedState {
  readonly phase: "finished";
  readonly activeSeats: readonly Seat[];
  readonly baseStake: number;
  readonly books: Books;
  /** Seats with the most books; more than one on a tie. */
  readonly winners: readonly Seat[];
  readonly lastEvents: readonly GameEvent[];
}

export type GameState = PlayingState | FinishedState;

export type RejectionReason = "wrong-phase" | "not-your-turn" | "invalid-target" | "invalid-rank" | "rank-not-in-hand";

export type ApplyResult = { ok: true; state: GameState } | { ok: false; reason: RejectionReason };

export interface CreateGameOptions {
  /** Exactly 52 distinct cards, already shuffled by the caller. */
  readonly shuffledDeck: readonly Card[];
  /** 2-5 distinct seats taking part. */
  readonly activeSeats: readonly Seat[];
  /** Seat that asks first; must be active. */
  readonly firstSeat: Seat;
  readonly baseStake: number;
}

type Hands = Record<Seat, readonly Card[]>;
type MutableBooks = Record<Seat, readonly Rank[]>;

function emptyHands(): Hands {
  return { 0: [], 1: [], 2: [], 3: [], 4: [] };
}

function emptyBooks(): MutableBooks {
  return { 0: [], 1: [], 2: [], 3: [], 4: [] };
}

function validateActiveSeats(activeSeats: readonly Seat[]): readonly Seat[] {
  const unique = [...new Set(activeSeats)].sort((a, b) => a - b);
  if (unique.length !== activeSeats.length || unique.some((s) => !SEATS.includes(s))) {
    throw new Error(`activeSeats must be distinct seats 0-4, got ${JSON.stringify(activeSeats)}`);
  }
  if (unique.length < MIN_PLAYERS || unique.length > MAX_PLAYERS) {
    throw new Error(`activeSeats needs ${MIN_PLAYERS}-${MAX_PLAYERS} seats, got ${unique.length}`);
  }
  return unique;
}

export function nextActiveSeat(activeSeats: readonly Seat[], seat: Seat): Seat {
  const index = activeSeats.indexOf(seat);
  if (index === -1) throw new Error(`nextActiveSeat: seat ${seat} is not active`);
  return activeSeats[(index + 1) % activeSeats.length];
}

/** Working copy of a hand while one action resolves. */
interface Draft {
  hands: Hands;
  pool: Card[];
  books: MutableBooks;
  events: GameEvent[];
}

/** Lays down every complete four-of-a-rank in `seat`'s hand. */
function formBooks(draft: Draft, seat: Seat): void {
  const counts = new Map<Rank, number>();
  for (const card of draft.hands[seat]) counts.set(card.rank, (counts.get(card.rank) ?? 0) + 1);
  for (const [rank, count] of counts) {
    if (count !== 4) continue;
    draft.hands[seat] = draft.hands[seat].filter((c) => c.rank !== rank);
    draft.books[seat] = [...draft.books[seat], rank];
    draft.events.push({ type: "book", seat, rank });
  }
}

/**
 * Deals hand-size blocks off the top of the deck in seat order, the rest as
 * the pool, and lays down any book dealt outright.
 */
export function createGame(options: CreateGameOptions): PlayingState {
  const activeSeats = validateActiveSeats(options.activeSeats);
  if (!activeSeats.includes(options.firstSeat)) {
    throw new Error(`firstSeat ${options.firstSeat} is not in activeSeats`);
  }
  const deck = options.shuffledDeck;
  if (deck.length !== 52 || new Set(deck.map((c) => c.id)).size !== 52) {
    throw new Error(`createGame requires 52 distinct cards, got ${deck.length}`);
  }

  const handSize = handSizeFor(activeSeats.length);
  const draft: Draft = { hands: emptyHands(), pool: [], books: emptyBooks(), events: [] };
  let cursor = 0;
  for (const seat of activeSeats) {
    draft.hands[seat] = deck.slice(cursor, cursor + handSize);
    cursor += handSize;
  }
  // Pool top is the last element, so the next card dealt is the next drawn.
  draft.pool = deck.slice(cursor).reverse();
  for (const seat of activeSeats) formBooks(draft, seat);

  const state = resolveTurn({ activeSeats, baseStake: options.baseStake }, draft, options.firstSeat);
  if (state.phase !== "playing") throw new Error("unreachable: a deal cannot complete all 13 books");
  return state;
}

export function totalBooks(books: Books): number {
  return SEATS.reduce((sum: number, seat) => sum + books[seat].length, 0);
}

/**
 * Hands the turn to `candidate`, or the first later seat able to act: an
 * empty hand draws one pool card, and is skipped when the pool is empty too.
 * Finishes the hand once every book exists.
 */
function resolveTurn(base: Pick<PlayingState, "activeSeats" | "baseStake">, draft: Draft, candidate: Seat): GameState {
  if (totalBooks(draft.books) === BOOK_COUNT) return finish(base, draft);

  let seat = candidate;
  for (let i = 0; i < base.activeSeats.length; i++) {
    if (draft.hands[seat].length === 0) {
      const card = draft.pool.pop();
      if (card === undefined) {
        draft.events.push({ type: "skipped", seat });
        seat = nextActiveSeat(base.activeSeats, seat);
        continue;
      }
      draft.hands[seat] = [card];
      draft.events.push({ type: "refill", seat });
    }
    return {
      phase: "playing",
      activeSeats: base.activeSeats,
      baseStake: base.baseStake,
      hands: draft.hands,
      pool: draft.pool,
      books: draft.books,
      currentTurn: seat,
      lastEvents: draft.events,
    };
  }
  // Unreachable while books < 13: some card is in a hand or the pool.
  return finish(base, draft);
}

function finish(base: Pick<PlayingState, "activeSeats" | "baseStake">, draft: Draft): FinishedState {
  const most = Math.max(...base.activeSeats.map((s) => draft.books[s].length));
  return {
    phase: "finished",
    activeSeats: base.activeSeats,
    baseStake: base.baseStake,
    books: draft.books,
    winners: base.activeSeats.filter((s) => draft.books[s].length === most),
    lastEvents: draft.events,
  };
}

export function applyAction(state: GameState, seat: Seat, action: Action): ApplyResult {
  if (state.phase !== "playing") return { ok: false, reason: "wrong-phase" };
  if (seat !== state.currentTurn) return { ok: false, reason: "not-your-turn" };
  if (!Number.isInteger(action.rank) || !RANKS.includes(action.rank as Rank)) {
    return { ok: false, reason: "invalid-rank" };
  }
  const rank = action.rank as Rank;
  const { target } = action;
  if (target === seat || !state.activeSeats.includes(target)) return { ok: false, reason: "invalid-target" };
  if (!state.hands[seat].some((c) => c.rank === rank)) return { ok: false, reason: "rank-not-in-hand" };

  const draft: Draft = {
    hands: { ...state.hands },
    pool: state.pool.slice(),
    books: { ...state.books },
    events: [{ type: "asked", seat, target, rank }],
  };

  const handed = draft.hands[target].filter((c) => c.rank === rank);
  if (handed.length > 0) {
    draft.hands[target] = draft.hands[target].filter((c) => c.rank !== rank);
    draft.hands[seat] = [...draft.hands[seat], ...handed];
    draft.events.push({ type: "hit", seat, target, rank, count: handed.length });
    formBooks(draft, seat);
    return { ok: true, state: resolveTurn(state, draft, seat) };
  }

  draft.events.push({ type: "go-fish", seat, target, rank });
  const drawn = draft.pool.pop();
  if (drawn === undefined) {
    return { ok: true, state: resolveTurn(state, draft, nextActiveSeat(state.activeSeats, seat)) };
  }
  draft.hands[seat] = [...draft.hands[seat], drawn];
  const matched = drawn.rank === rank;
  draft.events.push(matched ? { type: "drew-match", seat, rank } : { type: "drew-hidden", seat });
  formBooks(draft, seat);
  const next = matched ? seat : nextActiveSeat(state.activeSeats, seat);
  return { ok: true, state: resolveTurn(state, draft, next) };
}

// --- Redacted per-seat views -------------------------------------------------

export interface RedactedPlayingView {
  readonly phase: "playing";
  readonly viewer: Seat;
  readonly activeSeats: readonly Seat[];
  readonly baseStake: number;
  /** Empty for a seat outside activeSeats. */
  readonly hand: readonly Card[];
  readonly handCounts: Readonly<Record<Seat, number>>;
  readonly books: Books;
  readonly poolCount: number;
  readonly currentTurn: Seat;
  readonly lastEvents: readonly GameEvent[];
}

export type RedactedFinishedView = FinishedState & { readonly viewer: Seat };

export type RedactedView = RedactedPlayingView | RedactedFinishedView;

function handCountsOf(hands: Readonly<Record<Seat, readonly Card[]>>): Record<Seat, number> {
  return { 0: hands[0].length, 1: hands[1].length, 2: hands[2].length, 3: hands[3].length, 4: hands[4].length };
}

/** Own hand in full, opponents as counts. Books and events are public; a hidden draw stays hidden. */
export function viewFor(state: GameState, viewer: Seat): RedactedView {
  if (state.phase === "finished") return { ...state, viewer };
  return {
    phase: "playing",
    viewer,
    activeSeats: state.activeSeats,
    baseStake: state.baseStake,
    hand: state.hands[viewer],
    handCounts: handCountsOf(state.hands),
    books: state.books,
    poolCount: state.pool.length,
    currentTurn: state.currentTurn,
    lastEvents: state.lastEvents,
  };
}

// --- Settlement ---------------------------------------------------------------

export type SeatDeltas = Readonly<Record<Seat, number>>;

/**
 * Pairwise: every seat pays one stake per book of difference to every seat
 * with more, so delta = stake × (players × ownBooks − 13). Sums to zero.
 */
export function settle(state: FinishedState): SeatDeltas {
  const players = state.activeSeats.length;
  const deltas: Record<Seat, number> = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0 };
  for (const seat of state.activeSeats) {
    deltas[seat] = state.baseStake * (players * state.books[seat].length - BOOK_COUNT);
  }
  return deltas;
}
