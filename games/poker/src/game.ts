import type { Card } from "./cards";
import {
  blindSeats,
  dealHoleCards,
  firstToActPostflop,
  firstToActPreflop,
  orderFrom,
  sortSeats,
  type Seat,
} from "./deal";
import { compareHands, evaluateBestHand, type HandCategory, type HandResult } from "./evaluator";

export type Street = "preflop" | "flop" | "turn" | "river";

/** Every player's effective stack, every hand: STARTING_STACK_MULTIPLE x stake. Stacks never
 * persist across hands (each hand is settled independently) — see settle() below. */
export const STARTING_STACK_MULTIPLE = 100;

export interface PlayerHandState {
  readonly holeCards: readonly [Card, Card];
  readonly folded: boolean;
  /** Total chips committed to the pot this hand, across all streets (blinds + every bet/call/raise). */
  readonly committed: number;
  /** Chips committed during the CURRENT betting street only; reset to 0 at the start of each street. */
  readonly streetCommitted: number;
}

interface TableState {
  /** Ascending == clockwise seating order. Fixed for the whole hand. */
  readonly seats: readonly Seat[];
  readonly dealerSeat: Seat;
  /** The big blind. */
  readonly stake: number;
  readonly players: Readonly<Record<Seat, PlayerHandState>>;
  readonly community: readonly Card[];
}

export interface BettingState extends TableState {
  readonly phase: Street;
  readonly currentTurn: Seat;
  /** Seats still owed an action before this street closes; toAct[0] === currentTurn. Only ever
   * contains active (not folded, not all-in) seats — an all-in seat has nothing left to decide. */
  readonly toAct: readonly Seat[];
  /** Total streetCommitted a player must reach to call. */
  readonly currentBet: number;
  /** Minimum increment the NEXT full-size bet/raise must add. Reset to `stake` at the start of
   * every street; updated to the increment of the last FULL raise (a short all-in raise leaves it
   * unchanged — see applyRaise/applyBet). */
  readonly minRaiseIncrement: number;
  /** Seats that may currently only call or fold, not raise: the only increase in currentBet since
   * their last action was a short (sub-minimum) all-in raise, which does not reopen betting for
   * them (standard no-limit rule). Cleared by any subsequent FULL bet/raise. */
  readonly restricted: readonly Seat[];
  /** Cards not yet dealt to hands or the board. */
  readonly deck: readonly Card[];
}

export interface ShowdownResult {
  readonly seat: Seat;
  readonly hand: HandResult;
}

export interface ShowdownState extends TableState {
  readonly phase: "showdown";
  readonly pot: number;
  /** One entry per non-folded seat. */
  readonly results: readonly ShowdownResult[];
  readonly winners: readonly Seat[];
  readonly amountWon: Readonly<Record<Seat, number>>;
}

/** Everyone folded to one player — an uncontested win with no reveal. */
export interface FinishedState extends TableState {
  readonly phase: "finished";
  readonly pot: number;
  readonly winner: Seat;
}

export type GameState = BettingState | ShowdownState | FinishedState;
export type HandOverState = ShowdownState | FinishedState;

export type Action =
  | { readonly type: "fold" }
  | { readonly type: "check" }
  | { readonly type: "call" }
  | { readonly type: "bet"; readonly amount: number }
  | { readonly type: "raise"; readonly toAmount: number };

export type RejectionReason =
  | "wrong-phase"
  | "not-your-turn"
  | "cannot-check"
  | "bet-too-small"
  | "raise-too-small"
  | "insufficient-stack"
  | "folded-player-action"
  | "invalid-amount";

export type ApplyResult = { readonly ok: true; readonly state: GameState } | { readonly ok: false; readonly reason: RejectionReason };

export interface CreateGameOptions {
  /** 2-8 seat numbers (integers 0-7), unique; need not be contiguous. */
  readonly seats: readonly Seat[];
  /** Must be one of `seats`. The caller rotates this across hands — see nextDealerSeat in ./deal. */
  readonly dealerSeat: Seat;
  /** The big blind. Small blind is floor(stake/2), minimum 1. */
  readonly stake: number;
  /** Exactly 52 cards, already shuffled by the caller (see shuffleDeck / createSeededRandom in ./cards). */
  readonly shuffledDeck: readonly Card[];
}

function smallBlindAmount(stake: number): number {
  return Math.max(1, Math.floor(stake / 2));
}

function remainingStack(state: TableState, seat: Seat): number {
  return STARTING_STACK_MULTIPLE * state.stake - state.players[seat].committed;
}

/** Can still act this street: not folded, and has chips left to act with. */
function isActive(state: TableState, seat: Seat): boolean {
  return !state.players[seat].folded && remainingStack(state, seat) > 0;
}

function potOf(state: TableState): number {
  return state.seats.reduce((sum, s) => sum + state.players[s].committed, 0);
}

function withPlayer(
  players: Readonly<Record<Seat, PlayerHandState>>,
  seat: Seat,
  next: PlayerHandState,
): Record<Seat, PlayerHandState> {
  return { ...players, [seat]: next };
}

// --- Creation -----------------------------------------------------------------

export function createGame(options: CreateGameOptions): BettingState {
  const seats = sortSeats(options.seats);
  if (seats.length < 2 || seats.length > 8) {
    throw new Error(`createGame requires 2-8 seats, got ${seats.length}`);
  }
  if (new Set(seats).size !== seats.length) {
    throw new Error("createGame: seats must be unique");
  }
  if (seats.some((s) => !Number.isInteger(s) || s < 0 || s > 7)) {
    throw new Error("createGame: seat numbers must be integers in 0-7");
  }
  if (!seats.includes(options.dealerSeat)) {
    throw new Error("createGame: dealerSeat must be one of seats");
  }
  if (!Number.isInteger(options.stake) || options.stake < 1) {
    throw new Error("createGame: stake must be a positive integer");
  }

  const { holeCards, remainingDeck } = dealHoleCards(options.shuffledDeck, seats);
  const players: Record<Seat, PlayerHandState> = {};
  for (const seat of seats) {
    players[seat] = { holeCards: holeCards[seat], folded: false, committed: 0, streetCommitted: 0 };
  }

  const { smallBlind, bigBlind } = blindSeats(seats, options.dealerSeat);
  const sbAmount = smallBlindAmount(options.stake);
  players[smallBlind] = { ...players[smallBlind], committed: sbAmount, streetCommitted: sbAmount };
  players[bigBlind] = { ...players[bigBlind], committed: options.stake, streetCommitted: options.stake };

  const firstSeat = firstToActPreflop(seats, bigBlind);
  // Everyone is active at creation (100x stake dwarfs any blind), so the whole clockwise order
  // starting at firstSeat is the toAct queue — it naturally ends on the big blind, who gets the
  // last word on a call-around ("the option"), per standard rules.
  const toAct = orderFrom(seats, firstSeat);

  return {
    phase: "preflop",
    seats,
    dealerSeat: options.dealerSeat,
    stake: options.stake,
    players,
    community: [],
    currentTurn: firstSeat,
    toAct,
    currentBet: options.stake,
    minRaiseIncrement: options.stake,
    restricted: [],
    deck: remainingDeck,
  };
}

// --- Actions --------------------------------------------------------------------

export function applyAction(state: GameState, seat: Seat, action: Action): ApplyResult {
  if (state.phase === "showdown" || state.phase === "finished") {
    return { ok: false, reason: "wrong-phase" };
  }
  const player = state.players[seat];
  if (!player) return { ok: false, reason: "not-your-turn" };
  if (player.folded) return { ok: false, reason: "folded-player-action" };
  if (seat !== state.currentTurn) return { ok: false, reason: "not-your-turn" };

  switch (action.type) {
    case "fold":
      return applyFold(state, seat);
    case "check":
      return applyCheck(state, seat);
    case "call":
      return applyCall(state, seat);
    case "bet":
      return applyBet(state, seat, action.amount);
    case "raise":
      return applyRaise(state, seat, action.toAmount);
    default:
      return { ok: false, reason: "invalid-amount" };
  }
}

function applyFold(state: BettingState, seat: Seat): ApplyResult {
  const players = withPlayer(state.players, seat, { ...state.players[seat], folded: true });
  const nonFolded = state.seats.filter((s) => !players[s].folded);
  if (nonFolded.length === 1) {
    return { ok: true, state: finishByFold({ ...state, players }, nonFolded[0]) };
  }
  const toAct = state.toAct.filter((s) => s !== seat);
  const restricted = state.restricted.filter((s) => s !== seat);
  return { ok: true, state: advance({ ...state, players, toAct, restricted }) };
}

function applyCheck(state: BettingState, seat: Seat): ApplyResult {
  if (state.players[seat].streetCommitted !== state.currentBet) {
    return { ok: false, reason: "cannot-check" };
  }
  const toAct = state.toAct.filter((s) => s !== seat);
  return { ok: true, state: advance({ ...state, toAct }) };
}

function applyCall(state: BettingState, seat: Seat): ApplyResult {
  const player = state.players[seat];
  const delta = state.currentBet - player.streetCommitted;
  // With every seat starting the hand at exactly the same stack, nobody can ever face a call they
  // can't fully cover: the highest currentBet any seat can reach is capped at that shared starting
  // stack. Kept as a defensive invariant check rather than a reachable rejection in normal play.
  if (delta > remainingStack(state, seat)) return { ok: false, reason: "insufficient-stack" };

  const updated = { ...player, committed: player.committed + delta, streetCommitted: state.currentBet };
  const players = withPlayer(state.players, seat, updated);
  const toAct = state.toAct.filter((s) => s !== seat);
  return { ok: true, state: advance({ ...state, players, toAct }) };
}

function applyBet(state: BettingState, seat: Seat, amount: number): ApplyResult {
  // A "bet" only exists while nobody has bet this street yet; once currentBet > 0 the only way to
  // increase it is a "raise" (see applyRaise) — this mirrors the standard bet/raise UI distinction.
  if (state.currentBet !== 0) return { ok: false, reason: "invalid-amount" };
  if (!Number.isInteger(amount) || amount <= 0) return { ok: false, reason: "invalid-amount" };

  const stack = remainingStack(state, seat);
  if (amount > stack) return { ok: false, reason: "insufficient-stack" };
  const isAllIn = amount === stack;
  if (amount < state.stake && !isAllIn) return { ok: false, reason: "bet-too-small" };

  const player = state.players[seat];
  const updated = { ...player, committed: player.committed + amount, streetCommitted: amount };
  const players = withPlayer(state.players, seat, updated);

  // minRaiseIncrement is always exactly `stake` here (a bet is only legal at the start of a fresh
  // street, right after it was reset) — "full" means the bet meets that bar.
  const isFull = amount >= state.minRaiseIncrement;
  const { toAct, restricted, minRaiseIncrement } = reopenAfterIncrease(state, seat, isFull, amount);
  return { ok: true, state: advance({ ...state, players, currentBet: amount, minRaiseIncrement, toAct, restricted }) };
}

function applyRaise(state: BettingState, seat: Seat, toAmount: number): ApplyResult {
  if (state.currentBet === 0) return { ok: false, reason: "invalid-amount" }; // should be a bet, not a raise
  if (!Number.isInteger(toAmount) || toAmount <= state.currentBet) return { ok: false, reason: "invalid-amount" };

  // A restricted seat is barred from raising at all right now, regardless of size — see the
  // `restricted` field's doc comment. Checked before the stack/amount checks below since it's an
  // absolute bar independent of what amount was requested (the "raise" option isn't available to
  // this seat in this spot at all, not just the specific amount they picked). There's no dedicated
  // rejection code in this engine's typed taxonomy for "you can't reopen betting here"; it's
  // mapped onto raise-too-small since the restriction only ever exists because some earlier raise
  // fell short of the minimum, the same underlying condition that code otherwise reports.
  if (state.restricted.includes(seat)) return { ok: false, reason: "raise-too-small" };

  const player = state.players[seat];
  const delta = toAmount - player.streetCommitted;
  const stack = remainingStack(state, seat);
  if (delta > stack) return { ok: false, reason: "insufficient-stack" };
  const isAllIn = delta === stack;

  const increment = toAmount - state.currentBet;
  if (increment < state.minRaiseIncrement && !isAllIn) return { ok: false, reason: "raise-too-small" };

  const updated = { ...player, committed: player.committed + delta, streetCommitted: toAmount };
  const players = withPlayer(state.players, seat, updated);

  const isFull = increment >= state.minRaiseIncrement;
  const { toAct, restricted, minRaiseIncrement } = reopenAfterIncrease(state, seat, isFull, increment);
  return { ok: true, state: advance({ ...state, players, currentBet: toAmount, minRaiseIncrement, toAct, restricted }) };
}

/**
 * Shared toAct/restricted/minRaiseIncrement transition for any action that raises currentBet
 * (a fresh bet counts as raising it from 0). `state` is the PRE-action state (other seats' folded/
 * stack status is unaffected by the acting seat's own update, so it's safe to read from here).
 *
 * A FULL raise reopens the action for every other active seat and clears all restrictions. A SHORT
 * (sub-minimum, forced-all-in) raise does not: it still queues every other active seat to respond
 * (they owe the small delta, or must fold), but any of them who had *already* acted on the current
 * bet level before this raise (i.e. weren't still sitting in the old toAct queue) become newly
 * restricted to call-or-fold, in addition to whoever was already restricted from an earlier short
 * raise this street (restrictions only ever accumulate until a full raise clears them all).
 */
function reopenAfterIncrease(
  state: BettingState,
  raiserSeat: Seat,
  isFull: boolean,
  increment: number,
): { toAct: Seat[]; restricted: Seat[]; minRaiseIncrement: number } {
  const others = orderFrom(state.seats, raiserSeat).filter((s) => s !== raiserSeat && isActive(state, s));
  if (isFull) {
    return { toAct: others, restricted: [], minRaiseIncrement: increment };
  }
  const newlyRestricted = others.filter((s) => !state.toAct.includes(s));
  const carriedRestricted = state.restricted.filter((s) => others.includes(s));
  const restricted = [...new Set([...carriedRestricted, ...newlyRestricted])];
  return { toAct: others, restricted, minRaiseIncrement: state.minRaiseIncrement };
}

/** After any action that doesn't end the hand outright (a fold-to-one is handled by its caller
 * before reaching here): move to the next actor, or close the street if nobody's left to act. */
function advance(state: BettingState): GameState {
  if (state.toAct.length === 0) return closeStreet(state);
  return { ...state, currentTurn: state.toAct[0] };
}

function closeStreet(state: BettingState): GameState {
  const nonFolded = state.seats.filter((s) => !state.players[s].folded);
  const canAct = nonFolded.filter((s) => remainingStack(state, s) > 0);
  // At most one player left who could possibly act further (the rest are all-in or folded) — no
  // more betting is possible this hand. Deal straight through to the river and go to showdown
  // (the standard "all-in, run it out" rule). Also true once the river itself has closed normally.
  if (state.phase === "river" || canAct.length <= 1) {
    return toShowdown(dealRemainingCommunity(state));
  }
  return dealNextStreet(state);
}

function dealRemainingCommunity(state: BettingState): TableState {
  const needed = 5 - state.community.length;
  return { ...state, community: [...state.community, ...state.deck.slice(0, needed)] };
}

function dealNextStreet(state: BettingState): BettingState {
  const nextStreet: Street = state.phase === "preflop" ? "flop" : state.phase === "flop" ? "turn" : "river";
  const cardsToAdd = nextStreet === "flop" ? 3 : 1;
  const community = [...state.community, ...state.deck.slice(0, cardsToAdd)];
  const deck = state.deck.slice(cardsToAdd);

  const players: Record<Seat, PlayerHandState> = {};
  for (const s of state.seats) players[s] = { ...state.players[s], streetCommitted: 0 };

  // isActive only reads `committed` (untouched by the street transition), so it's safe to compute
  // against the pre-reset `state` even though `players` above already has streetCommitted zeroed.
  const startSeat = firstToActPostflop(state.seats, state.dealerSeat);
  const toAct = orderFrom(state.seats, startSeat).filter((s) => isActive(state, s));
  // Non-empty: closeStreet only calls dealNextStreet when canAct.length > 1.
  const currentTurn = toAct[0];

  return {
    phase: nextStreet,
    seats: state.seats,
    dealerSeat: state.dealerSeat,
    stake: state.stake,
    players,
    community,
    deck,
    currentTurn,
    toAct,
    currentBet: 0,
    minRaiseIncrement: state.stake,
    restricted: [],
  };
}

function toShowdown(base: TableState): ShowdownState {
  const nonFolded = base.seats.filter((s) => !base.players[s].folded);
  const results: ShowdownResult[] = nonFolded.map((seat) => ({
    seat,
    hand: evaluateBestHand([...base.players[seat].holeCards, ...base.community]),
  }));
  const best = results.reduce((max, r) => (compareHands(r.hand, max.hand) > 0 ? r : max));
  const winners = results.filter((r) => compareHands(r.hand, best.hand) === 0).map((r) => r.seat);
  const pot = potOf(base);
  return {
    phase: "showdown",
    seats: base.seats,
    dealerSeat: base.dealerSeat,
    stake: base.stake,
    players: base.players,
    community: base.community,
    pot,
    results,
    winners,
    amountWon: splitPot(pot, winners, base.seats, base.dealerSeat),
  };
}

/**
 * Split a tied pot evenly; when it doesn't divide evenly, the 1-chip remainders go to the earliest
 * winners in clockwise order STARTING FROM the dealer seat (the dealer counts as the very first
 * position if the dealer is itself among the winners) — one extra chip per winner, in that order,
 * until the remainder runs out.
 *
 * Judgment call: many rooms instead start counting from the seat immediately left of the button
 * (skipping the button itself) so the button is the last to receive an odd chip, not the first.
 * The spec's own wording — "earliest seat clockwise from the dealer" — is taken literally here,
 * i.e. inclusive of the dealer seat.
 */
function splitPot(
  pot: number,
  winners: readonly Seat[],
  seats: readonly Seat[],
  dealerSeat: Seat,
): Record<Seat, number> {
  const base = Math.floor(pot / winners.length);
  const remainder = pot - base * winners.length;
  const order = orderFrom(seats, dealerSeat).filter((s) => winners.includes(s));
  const amountWon: Record<Seat, number> = {};
  for (const s of seats) amountWon[s] = 0;
  order.forEach((s, i) => {
    amountWon[s] = base + (i < remainder ? 1 : 0);
  });
  return amountWon;
}

function finishByFold(state: TableState, winnerSeat: Seat): FinishedState {
  return {
    phase: "finished",
    seats: state.seats,
    dealerSeat: state.dealerSeat,
    stake: state.stake,
    players: state.players,
    community: state.community,
    pot: potOf(state),
    winner: winnerSeat,
  };
}

// --- Redacted per-seat views ------------------------------------------------------

export interface PublicBettingStatus {
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly committed: number;
  readonly streetCommitted: number;
  /** Hole cards are never revealed pre-showdown; this is always 2 (hold'em hands never change
   * size), included so opponents' cards show up as a count rather than being absent entirely. */
  readonly holeCardCount: 2;
}

export interface RedactedBettingView {
  readonly phase: Street;
  readonly viewer: Seat;
  readonly seats: readonly Seat[];
  readonly dealerSeat: Seat;
  readonly stake: number;
  readonly community: readonly Card[];
  readonly pot: number;
  readonly currentBet: number;
  readonly currentTurn: Seat;
  /** The viewer's own hole cards; never present for any other seat. */
  readonly holeCards: readonly [Card, Card];
  readonly players: Readonly<Record<Seat, PublicBettingStatus>>;
}

export interface PublicTerminalStatus {
  readonly folded: boolean;
  readonly committed: number;
}

export interface ShowdownReveal {
  readonly seat: Seat;
  readonly holeCards: readonly [Card, Card];
  readonly hand: { readonly category: HandCategory; readonly ranks: readonly number[] };
}

export interface RedactedShowdownView {
  readonly phase: "showdown";
  readonly viewer: Seat;
  readonly seats: readonly Seat[];
  readonly dealerSeat: Seat;
  readonly stake: number;
  readonly community: readonly Card[];
  readonly pot: number;
  readonly winners: readonly Seat[];
  readonly amountWon: Readonly<Record<Seat, number>>;
  /** Non-folded seats only — a folded hand is never revealed. */
  readonly reveals: readonly ShowdownReveal[];
  readonly players: Readonly<Record<Seat, PublicTerminalStatus>>;
}

export interface RedactedFinishedView {
  readonly phase: "finished";
  readonly viewer: Seat;
  readonly seats: readonly Seat[];
  readonly dealerSeat: Seat;
  readonly stake: number;
  readonly community: readonly Card[];
  readonly pot: number;
  readonly winner: Seat;
  readonly players: Readonly<Record<Seat, PublicTerminalStatus>>;
}

export type RedactedView = RedactedBettingView | RedactedShowdownView | RedactedFinishedView;

function publicBettingStatus(state: BettingState): Record<Seat, PublicBettingStatus> {
  const out: Record<Seat, PublicBettingStatus> = {};
  for (const seat of state.seats) {
    const p = state.players[seat];
    out[seat] = {
      folded: p.folded,
      allIn: !p.folded && remainingStack(state, seat) === 0,
      committed: p.committed,
      streetCommitted: p.streetCommitted,
      holeCardCount: 2,
    };
  }
  return out;
}

function publicTerminalStatus(state: TableState): Record<Seat, PublicTerminalStatus> {
  const out: Record<Seat, PublicTerminalStatus> = {};
  for (const seat of state.seats) {
    out[seat] = { folded: state.players[seat].folded, committed: state.players[seat].committed };
  }
  return out;
}

/** Per-seat view: own hole cards in full; opponents' hole cards never appear pre-showdown, only
 * a constant count. At showdown, every non-folded seat's hole cards and hand classification are
 * revealed to everyone (a folded hand stays hidden forever, matching real poker). */
export function viewFor(state: GameState, viewer: Seat): RedactedView {
  if (state.phase === "showdown") {
    return {
      phase: "showdown",
      viewer,
      seats: state.seats,
      dealerSeat: state.dealerSeat,
      stake: state.stake,
      community: state.community,
      pot: state.pot,
      winners: state.winners,
      amountWon: state.amountWon,
      reveals: state.results.map((r) => ({
        seat: r.seat,
        holeCards: state.players[r.seat].holeCards,
        hand: { category: r.hand.category, ranks: r.hand.ranks },
      })),
      players: publicTerminalStatus(state),
    };
  }
  if (state.phase === "finished") {
    return {
      phase: "finished",
      viewer,
      seats: state.seats,
      dealerSeat: state.dealerSeat,
      stake: state.stake,
      community: state.community,
      pot: state.pot,
      winner: state.winner,
      players: publicTerminalStatus(state),
    };
  }
  return {
    phase: state.phase,
    viewer,
    seats: state.seats,
    dealerSeat: state.dealerSeat,
    stake: state.stake,
    community: state.community,
    pot: potOf(state),
    currentBet: state.currentBet,
    currentTurn: state.currentTurn,
    holeCards: state.players[viewer].holeCards,
    players: publicBettingStatus(state),
  };
}

// --- Settlement ---------------------------------------------------------------

export type SeatDeltas = Readonly<Record<Seat, number>>;

/**
 * Per-seat signed delta = winnings - total chips committed this hand (each player's own
 * committed total, including a folded player's forfeited blinds/bets). Always sums to zero:
 * total winnings always equal the pot, and the pot always equals total committed. The stake
 * itself is read from `state` (set once at createGame), so a caller can't mis-pay by passing a
 * mismatched value — mirrors doudizhu's and liarsbar's settle(FinishedState).
 */
export function settle(state: HandOverState): SeatDeltas {
  const deltas: Record<Seat, number> = {};
  for (const seat of state.seats) {
    const won = state.phase === "finished" ? (seat === state.winner ? state.pot : 0) : state.amountWon[seat];
    deltas[seat] = won - state.players[seat].committed;
  }
  return deltas;
}
