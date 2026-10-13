import { compareCards, type Card } from "./cards";
import { HAND_SIZE, SEATS, dealHands, nextActiveSeat, type Seat } from "./deal";
import { beats, classifyCombo, type Combo } from "./combos";

export type Action = { type: "play"; cardIds: readonly string[] } | { type: "pass" };

/** One history entry; `combo` is null for a pass. */
export interface PlayRecord {
  readonly seat: Seat;
  readonly combo: Combo | null;
}

export interface PlayingState {
  readonly phase: "playing";
  /** 2-4 seats dealt in, ascending. Other seats hold no cards and settle at 0. */
  readonly activeSeats: readonly Seat[];
  readonly baseStake: number;
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  readonly currentTurn: Seat;
  /** Play to beat; null on a free lead. */
  readonly lastPlay: { readonly seat: Seat; readonly combo: Combo } | null;
  /** Lowest dealt card; the first play of the hand must include it. Null once played. */
  readonly leadCardId: string | null;
  readonly history: readonly PlayRecord[];
}

export interface FinishedState {
  readonly phase: "finished";
  readonly activeSeats: readonly Seat[];
  readonly baseStake: number;
  readonly winner: Seat;
  /** Cards left in each hand; public once the hand ends. */
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  readonly history: readonly PlayRecord[];
}

export type GameState = PlayingState | FinishedState;

export type RejectionReason =
  | "wrong-phase"
  | "not-your-turn"
  | "empty-play"
  | "invalid-cards"
  | "cards-not-in-hand"
  | "wrong-card-count"
  | "must-beat-previous"
  | "must-include-lead-card"
  | "cannot-pass-on-lead";

export type ApplyResult = { ok: true; state: GameState } | { ok: false; reason: RejectionReason };

export interface CreateGameOptions {
  /** Exactly 52 cards, already shuffled by the caller. */
  readonly shuffledDeck: readonly Card[];
  /** 2-4 distinct seats taking part; omitted means all four. */
  readonly activeSeats?: readonly Seat[];
  readonly baseStake: number;
}

function validateActiveSeats(activeSeats: readonly Seat[]): readonly Seat[] {
  const unique = [...new Set(activeSeats)].sort((a, b) => a - b);
  if (unique.length !== activeSeats.length || unique.some((s) => !SEATS.includes(s))) {
    throw new Error(`activeSeats must be distinct seats 0-3, got ${JSON.stringify(activeSeats)}`);
  }
  if (unique.length < 2) throw new Error(`activeSeats needs at least 2 seats, got ${unique.length}`);
  return unique;
}

/** Deals and hands the lead to whoever holds the lowest dealt card. */
export function createGame(options: CreateGameOptions): PlayingState {
  const activeSeats = validateActiveSeats(options.activeSeats ?? SEATS);
  const hands = dealHands(options.shuffledDeck, activeSeats);

  let leadSeat = activeSeats[0];
  let leadCard = hands[leadSeat][0];
  for (const seat of activeSeats) {
    for (const card of hands[seat]) {
      if (compareCards(card, leadCard) < 0) {
        leadCard = card;
        leadSeat = seat;
      }
    }
  }

  return {
    phase: "playing",
    activeSeats,
    baseStake: options.baseStake,
    hands,
    currentTurn: leadSeat,
    lastPlay: null,
    leadCardId: leadCard.id,
    history: [],
  };
}

export function applyAction(state: GameState, seat: Seat, action: Action): ApplyResult {
  if (state.phase !== "playing") return { ok: false, reason: "wrong-phase" };
  if (seat !== state.currentTurn) return { ok: false, reason: "not-your-turn" };
  if (action.type === "pass") return applyPass(state, seat);
  return applyPlay(state, seat, action.cardIds);
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

function applyPass(state: PlayingState, seat: Seat): ApplyResult {
  if (state.lastPlay === null) return { ok: false, reason: "cannot-pass-on-lead" };
  const next = nextActiveSeat(state.activeSeats, seat);
  const history = [...state.history, { seat, combo: null }];
  // Turn back at the last player: everyone else passed, trick clears.
  const lastPlay = next === state.lastPlay.seat ? null : state.lastPlay;
  return { ok: true, state: { ...state, history, lastPlay, currentTurn: next } };
}

function applyPlay(state: PlayingState, seat: Seat, cardIds: readonly string[]): ApplyResult {
  if (cardIds.length === 0) return { ok: false, reason: "empty-play" };
  if (new Set(cardIds).size !== cardIds.length) return { ok: false, reason: "invalid-cards" };

  const hand = state.hands[seat];
  const cards: Card[] = [];
  for (const id of cardIds) {
    const card = hand.find((c) => c.id === id);
    if (!card) return { ok: false, reason: "cards-not-in-hand" };
    cards.push(card);
  }

  const combo = classifyCombo(cards);
  if (!combo) return { ok: false, reason: "invalid-cards" };
  if (state.leadCardId !== null && !cardIds.includes(state.leadCardId)) {
    return { ok: false, reason: "must-include-lead-card" };
  }
  if (state.lastPlay !== null) {
    if (state.lastPlay.combo.cards.length !== cards.length) return { ok: false, reason: "wrong-card-count" };
    if (!beats(state.lastPlay.combo, combo)) return { ok: false, reason: "must-beat-previous" };
  }

  const played = new Set(cardIds);
  const remaining = hand.filter((c) => !played.has(c.id));
  const hands = withHand(state.hands, seat, remaining);
  const history = [...state.history, { seat, combo }];

  if (remaining.length === 0) {
    return {
      ok: true,
      state: {
        phase: "finished",
        activeSeats: state.activeSeats,
        baseStake: state.baseStake,
        winner: seat,
        hands,
        history,
      },
    };
  }

  return {
    ok: true,
    state: {
      ...state,
      hands,
      history,
      lastPlay: { seat, combo },
      leadCardId: null,
      currentTurn: nextActiveSeat(state.activeSeats, seat),
    },
  };
}

// --- Redacted per-seat views -------------------------------------------------

export interface RedactedPlayingView {
  readonly phase: "playing";
  readonly viewer: Seat;
  readonly activeSeats: readonly Seat[];
  readonly hand: readonly Card[];
  readonly handCounts: Readonly<Record<Seat, number>>;
  readonly currentTurn: Seat;
  readonly lastPlay: { readonly seat: Seat; readonly combo: Combo } | null;
  readonly leadCardId: string | null;
  readonly history: readonly PlayRecord[];
  readonly baseStake: number;
}

export type RedactedFinishedView = FinishedState & { readonly viewer: Seat };

export type RedactedView = RedactedPlayingView | RedactedFinishedView;

function handCountsOf(hands: Readonly<Record<Seat, readonly Card[]>>): Record<Seat, number> {
  return { 0: hands[0].length, 1: hands[1].length, 2: hands[2].length, 3: hands[3].length };
}

/** Own hand in full, opponents as counts. Every hand is public once finished. */
export function viewFor(state: GameState, viewer: Seat): RedactedView {
  if (state.phase === "playing") {
    return {
      phase: "playing",
      viewer,
      activeSeats: state.activeSeats,
      hand: state.hands[viewer],
      handCounts: handCountsOf(state.hands),
      currentTurn: state.currentTurn,
      lastPlay: state.lastPlay,
      leadCardId: state.leadCardId,
      history: state.history,
      baseStake: state.baseStake,
    };
  }
  return { ...state, viewer };
}

// --- Settlement ---------------------------------------------------------------

export type SeatDeltas = Readonly<Record<Seat, number>>;

/** Per-card multiplier: 1 for 1-9 cards left, 2 for 10-12, 3 for a full 13. */
export function cardMultiplier(cardsLeft: number): number {
  if (cardsLeft >= HAND_SIZE) return 3;
  if (cardsLeft >= 10) return 2;
  return 1;
}

/** Each loser pays the winner cardsLeft × multiplier × baseStake. Sums to zero. */
export function settle(state: FinishedState): SeatDeltas {
  const deltas: Record<Seat, number> = { 0: 0, 1: 0, 2: 0, 3: 0 };
  let winnerTotal = 0;
  for (const seat of state.activeSeats) {
    if (seat === state.winner) continue;
    const left = state.hands[seat].length;
    const owed = left * cardMultiplier(left) * state.baseStake;
    deltas[seat] = -owed;
    winnerTotal += owed;
  }
  deltas[state.winner] = winnerTotal;
  return deltas;
}
