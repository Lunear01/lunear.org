import type { Card } from "./cards";
import { dealHands, nextSeat, type Seat } from "./deal";
import { beats, classifyCombo, type Combo } from "./combos";

export type BidAmount = 1 | 2 | 3;

export type Action =
  | { type: "bid"; amount: BidAmount }
  | { type: "pass" }
  | { type: "play"; cardIds: readonly string[] };

/** One entry in a playing-phase history log. `combo` is null for a pass. */
export interface PlayRecord {
  readonly seat: Seat;
  readonly combo: Combo | null;
}

export interface BiddingState {
  readonly phase: "bidding";
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  readonly landlordCards: readonly Card[];
  readonly currentBidder: Seat;
  readonly highestBid: number;
  readonly highestBidder: Seat | null;
  /** Count of bid/pass actions taken so far this (single-round) auction. */
  readonly bidsMade: number;
  readonly baseStake: number;
}

export interface PlayingState {
  readonly phase: "playing";
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  readonly landlord: Seat;
  /** The 3 bottom cards dealt aside during bidding; public once play starts (still held in the landlord's hand). */
  readonly landlordCards: readonly Card[];
  /** The winning bid (1-3); sets the base score multiplier. */
  readonly bidMultiplierBase: number;
  /** Bombs/rockets played so far this hand (doubles the score each). */
  readonly bombCount: number;
  readonly currentTurn: Seat;
  /** The play the current trick must beat; null when the current turn is a free lead. */
  readonly lastPlay: { seat: Seat; combo: Combo } | null;
  readonly passCountInRow: number;
  readonly history: readonly PlayRecord[];
  readonly baseStake: number;
}

export interface FinishedState {
  readonly phase: "finished";
  readonly landlord: Seat;
  /** The 3 bottom cards dealt aside during bidding; public since play started. */
  readonly landlordCards: readonly Card[];
  readonly winner: "landlord" | "farmers";
  readonly bombCount: number;
  readonly isSpring: boolean;
  readonly isAntiSpring: boolean;
  readonly bidMultiplierBase: number;
  readonly baseStake: number;
  readonly history: readonly PlayRecord[];
}

/** All three players passed during bidding; the caller must reshuffle and start a new game. */
export interface RedealState {
  readonly phase: "redeal";
  readonly baseStake: number;
}

export type GameState = BiddingState | PlayingState | FinishedState | RedealState;

export type RejectionReason =
  | "wrong-phase"
  | "not-your-turn"
  | "invalid-bid"
  | "bid-too-low"
  | "invalid-cards"
  | "cards-not-in-hand"
  | "must-beat-previous"
  | "cannot-pass-on-lead"
  | "empty-play";

export type ApplyResult = { ok: true; state: GameState } | { ok: false; reason: RejectionReason };

export interface CreateGameOptions {
  /** Exactly 54 cards, already shuffled by the caller (see shuffleDeck / createSeededRandom). */
  shuffledDeck: readonly Card[];
  /** Seat that bids first; the caller decides this (e.g. rotate, or its own RNG). */
  firstBidder: Seat;
  baseStake: number;
}

export function createGame(options: CreateGameOptions): BiddingState {
  const { hands, landlordCards } = dealHands(options.shuffledDeck);
  return {
    phase: "bidding",
    hands,
    landlordCards,
    currentBidder: options.firstBidder,
    highestBid: 0,
    highestBidder: null,
    bidsMade: 0,
    baseStake: options.baseStake,
  };
}

export function applyAction(state: GameState, seat: Seat, action: Action): ApplyResult {
  if (state.phase === "bidding") return applyBidAction(state, seat, action);
  if (state.phase === "playing") return applyPlayAction(state, seat, action);
  return { ok: false, reason: "wrong-phase" };
}

function applyBidAction(state: BiddingState, seat: Seat, action: Action): ApplyResult {
  if (action.type === "play") return { ok: false, reason: "wrong-phase" };
  if (seat !== state.currentBidder) return { ok: false, reason: "not-your-turn" };

  if (action.type === "bid") {
    if (action.amount !== 1 && action.amount !== 2 && action.amount !== 3) {
      return { ok: false, reason: "invalid-bid" };
    }
    if (action.amount <= state.highestBid) return { ok: false, reason: "bid-too-low" };

    const highestBid = action.amount;
    const highestBidder = seat;
    const bidsMade = state.bidsMade + 1;
    if (highestBid === 3 || bidsMade === 3) {
      return { ok: true, state: startPlaying(state, highestBidder, highestBid) };
    }
    return {
      ok: true,
      state: { ...state, currentBidder: nextSeat(seat), highestBid, highestBidder, bidsMade },
    };
  }

  // pass
  const bidsMade = state.bidsMade + 1;
  if (bidsMade === 3) {
    if (state.highestBidder === null) {
      return { ok: true, state: { phase: "redeal", baseStake: state.baseStake } };
    }
    return { ok: true, state: startPlaying(state, state.highestBidder, state.highestBid) };
  }
  return { ok: true, state: { ...state, currentBidder: nextSeat(seat), bidsMade } };
}

function startPlaying(state: BiddingState, landlord: Seat, bidMultiplierBase: number): PlayingState {
  const landlordHand = state.hands[landlord].concat(state.landlordCards);
  const hands = withHand(state.hands, landlord, landlordHand);
  return {
    phase: "playing",
    hands,
    landlord,
    landlordCards: state.landlordCards,
    bidMultiplierBase,
    bombCount: 0,
    currentTurn: landlord,
    lastPlay: null,
    passCountInRow: 0,
    history: [],
    baseStake: state.baseStake,
  };
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
  };
}

function applyPlayAction(state: PlayingState, seat: Seat, action: Action): ApplyResult {
  if (action.type === "bid") return { ok: false, reason: "wrong-phase" };
  if (seat !== state.currentTurn) return { ok: false, reason: "not-your-turn" };

  if (action.type === "pass") {
    if (state.lastPlay === null) return { ok: false, reason: "cannot-pass-on-lead" };
    return { ok: true, state: advanceAfterPass(state, seat) };
  }

  // play
  if (action.cardIds.length === 0) return { ok: false, reason: "empty-play" };
  if (new Set(action.cardIds).size !== action.cardIds.length) return { ok: false, reason: "invalid-cards" };

  const hand = state.hands[seat];
  const cards: Card[] = [];
  for (const id of action.cardIds) {
    const card = hand.find((c) => c.id === id);
    if (!card) return { ok: false, reason: "cards-not-in-hand" };
    cards.push(card);
  }

  const combo = classifyCombo(cards);
  if (!combo) return { ok: false, reason: "invalid-cards" };
  if (state.lastPlay !== null && !beats(state.lastPlay.combo, combo)) {
    return { ok: false, reason: "must-beat-previous" };
  }

  const playedIds = new Set(action.cardIds);
  const remainingHand = hand.filter((c) => !playedIds.has(c.id));
  const hands = withHand(state.hands, seat, remainingHand);
  const bombCount = state.bombCount + (combo.category === "bomb" || combo.category === "rocket" ? 1 : 0);
  const history = [...state.history, { seat, combo }];

  if (remainingHand.length === 0) {
    return { ok: true, state: finishGame({ ...state, hands, bombCount, history }, seat) };
  }

  return {
    ok: true,
    state: {
      ...state,
      hands,
      bombCount,
      history,
      lastPlay: { seat, combo },
      passCountInRow: 0,
      currentTurn: nextSeat(seat),
    },
  };
}

function advanceAfterPass(state: PlayingState, seat: Seat): PlayingState {
  const passCountInRow = state.passCountInRow + 1;
  const history = [...state.history, { seat, combo: null }];
  if (passCountInRow >= 2) {
    // Trick clears; the last player to play leads anew, free to play anything.
    const leader = state.lastPlay!.seat;
    return { ...state, history, lastPlay: null, passCountInRow: 0, currentTurn: leader };
  }
  return { ...state, history, passCountInRow, currentTurn: nextSeat(seat) };
}

function finishGame(state: PlayingState, winnerSeat: Seat): FinishedState {
  const winner: "landlord" | "farmers" = winnerSeat === state.landlord ? "landlord" : "farmers";
  const landlordPlays = state.history.filter((h) => h.seat === state.landlord && h.combo !== null).length;
  const farmerPlays = state.history.filter((h) => h.seat !== state.landlord && h.combo !== null).length;
  return {
    phase: "finished",
    landlord: state.landlord,
    landlordCards: state.landlordCards,
    winner,
    bombCount: state.bombCount,
    isSpring: winner === "landlord" && farmerPlays === 0,
    isAntiSpring: winner === "farmers" && landlordPlays === 1,
    bidMultiplierBase: state.bidMultiplierBase,
    baseStake: state.baseStake,
    history: state.history,
  };
}

// --- Redacted per-seat views -------------------------------------------------

export interface RedactedBiddingView {
  readonly phase: "bidding";
  readonly viewer: Seat;
  readonly hand: readonly Card[];
  readonly handCounts: Readonly<Record<Seat, number>>;
  readonly landlordCardCount: number;
  readonly currentBidder: Seat;
  readonly highestBid: number;
  readonly highestBidder: Seat | null;
  readonly baseStake: number;
}

export interface RedactedPlayingView {
  readonly phase: "playing";
  readonly viewer: Seat;
  readonly hand: readonly Card[];
  readonly handCounts: Readonly<Record<Seat, number>>;
  readonly landlord: Seat;
  /** The 3 bottom cards; public to all seats once play starts. */
  readonly landlordCards: readonly Card[];
  readonly bidMultiplierBase: number;
  readonly bombCount: number;
  readonly currentTurn: Seat;
  readonly lastPlay: { seat: Seat; combo: Combo } | null;
  readonly history: readonly PlayRecord[];
  readonly baseStake: number;
}

export type RedactedFinishedView = FinishedState & { readonly viewer: Seat };
export type RedactedRedealView = RedealState & { readonly viewer: Seat };

export type RedactedView =
  | RedactedBiddingView
  | RedactedPlayingView
  | RedactedFinishedView
  | RedactedRedealView;

function handCountsOf(hands: Readonly<Record<Seat, readonly Card[]>>): Record<Seat, number> {
  return { 0: hands[0].length, 1: hands[1].length, 2: hands[2].length };
}

/** Per-seat view: only the viewer's own hand is revealed; opponents' hands are counts only. */
export function viewFor(state: GameState, viewer: Seat): RedactedView {
  if (state.phase === "bidding") {
    return {
      phase: "bidding",
      viewer,
      hand: state.hands[viewer],
      handCounts: handCountsOf(state.hands),
      landlordCardCount: state.landlordCards.length,
      currentBidder: state.currentBidder,
      highestBid: state.highestBid,
      highestBidder: state.highestBidder,
      baseStake: state.baseStake,
    };
  }
  if (state.phase === "playing") {
    return {
      phase: "playing",
      viewer,
      hand: state.hands[viewer],
      handCounts: handCountsOf(state.hands),
      landlord: state.landlord,
      landlordCards: state.landlordCards,
      bidMultiplierBase: state.bidMultiplierBase,
      bombCount: state.bombCount,
      currentTurn: state.currentTurn,
      lastPlay: state.lastPlay,
      history: state.history,
      baseStake: state.baseStake,
    };
  }
  return { ...state, viewer };
}

// --- Settlement ---------------------------------------------------------------

export type SeatDeltas = Readonly<Record<Seat, number>>;

/**
 * Landlord wins: +2 shares to landlord, -1 share to each farmer.
 * Landlord loses: -2 shares to landlord, +1 share to each farmer.
 * One share = state.baseStake x winning bid x 2^bombsPlayed x (2 if spring/anti-spring).
 * Deltas always sum to zero. The stake is read from `state` (set once at createGame)
 * rather than taken as a parameter, so a caller can't mis-pay by passing a mismatched value.
 */
export function settle(state: FinishedState): SeatDeltas {
  const springMultiplier = state.isSpring || state.isAntiSpring ? 2 : 1;
  const pointsPerShare =
    state.baseStake * state.bidMultiplierBase * 2 ** state.bombCount * springMultiplier;
  const landlordDelta = state.winner === "landlord" ? 2 * pointsPerShare : -2 * pointsPerShare;
  const farmerDelta = state.winner === "landlord" ? -pointsPerShare : pointsPerShare;
  return {
    0: state.landlord === 0 ? landlordDelta : farmerDelta,
    1: state.landlord === 1 ? landlordDelta : farmerDelta,
    2: state.landlord === 2 ? landlordDelta : farmerDelta,
  };
}
