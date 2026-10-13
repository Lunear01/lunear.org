import { cardPoints, isWild, shuffleDeck, COLORS, type Card, type Color, type RandomSource } from "./cards";

export type Seat = 0 | 1 | 2 | 3 | 4 | 5;
export const SEATS: readonly Seat[] = [0, 1, 2, 3, 4, 5];

export const HAND_SIZE = 7;
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 6;

export type Direction = 1 | -1;

export type Action =
  | { type: "play"; cardId: string; color?: Color; uno?: boolean }
  | { type: "draw" }
  | { type: "pass" }
  | { type: "callUno" }
  | { type: "catchUno"; target: Seat };

/** What the last action did, in order. Public; reset on every action. */
export type GameEvent =
  | { readonly type: "played"; readonly seat: Seat; readonly card: Card; readonly color: Color }
  | { readonly type: "drew"; readonly seat: Seat; readonly count: number }
  | { readonly type: "passed"; readonly seat: Seat }
  | { readonly type: "skipped"; readonly seat: Seat }
  | { readonly type: "reversed" }
  | { readonly type: "reshuffled"; readonly count: number }
  | { readonly type: "called-uno"; readonly seat: Seat }
  | { readonly type: "caught"; readonly seat: Seat; readonly by: Seat };

export interface PlayingState {
  readonly phase: "playing";
  /** Seats dealt into this hand, fixed at createGame. Others settle at 0. */
  readonly activeSeats: readonly Seat[];
  readonly baseStake: number;
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  /** Top of the pile is the last element. */
  readonly drawPile: readonly Card[];
  /** Top of the pile is the last element. Never empty once dealt. */
  readonly discardPile: readonly Card[];
  /** Colour in force: the top card's, or the colour chosen for a wild. */
  readonly currentColor: Color;
  readonly direction: Direction;
  readonly currentTurn: Seat;
  /** A playable card the current seat just drew: they may play it or pass. */
  readonly pendingDraw: string | null;
  /** Seat whose last play left it one card without calling UNO; catchable until the next play/draw/pass. */
  readonly unoVulnerable: Seat | null;
  /** Seats that called UNO and still hold one card. */
  readonly unoCalled: readonly Seat[];
  readonly lastEvents: readonly GameEvent[];
}

export interface FinishedState {
  readonly phase: "finished";
  readonly activeSeats: readonly Seat[];
  readonly baseStake: number;
  readonly winner: Seat;
  /** Final hands, all public. */
  readonly hands: Readonly<Record<Seat, readonly Card[]>>;
  /** Points left in each hand; 0 for the winner and absent seats. */
  readonly points: Readonly<Record<Seat, number>>;
  readonly discardPile: readonly Card[];
  readonly currentColor: Color;
  readonly lastEvents: readonly GameEvent[];
}

export type GameState = PlayingState | FinishedState;

export type RejectionReason =
  | "wrong-phase"
  | "not-your-turn"
  | "cards-not-in-hand"
  | "card-not-playable"
  | "color-required"
  | "invalid-color"
  | "wild-draw-four-not-allowed"
  | "must-play-drawn-card"
  | "already-drew"
  | "cannot-pass"
  | "cannot-call-uno"
  | "nothing-to-catch";

export type ApplyResult = { ok: true; state: GameState } | { ok: false; reason: RejectionReason };

export interface CreateGameOptions {
  /** All 108 cards, already shuffled by the caller. */
  readonly shuffledDeck: readonly Card[];
  /** 2-6 distinct seats taking part. */
  readonly activeSeats: readonly Seat[];
  /** Seat that plays first; must be active. */
  readonly firstSeat: Seat;
  readonly baseStake: number;
}

function emptyHands(): Record<Seat, readonly Card[]> {
  return { 0: [], 1: [], 2: [], 3: [], 4: [], 5: [] };
}

function withHand(
  hands: Readonly<Record<Seat, readonly Card[]>>,
  seat: Seat,
  hand: readonly Card[],
): Record<Seat, readonly Card[]> {
  return { ...hands, [seat]: hand };
}

function validateActiveSeats(activeSeats: readonly Seat[]): readonly Seat[] {
  const unique = [...new Set(activeSeats)].sort((a, b) => a - b);
  if (unique.length !== activeSeats.length || unique.some((s) => !SEATS.includes(s))) {
    throw new Error(`activeSeats must be distinct seats 0-5, got ${JSON.stringify(activeSeats)}`);
  }
  if (unique.length < MIN_PLAYERS || unique.length > MAX_PLAYERS) {
    throw new Error(`activeSeats needs ${MIN_PLAYERS}-${MAX_PLAYERS} seats, got ${unique.length}`);
  }
  return unique;
}

/**
 * Deals HAND_SIZE cards per active seat in seat order, as consecutive blocks
 * off the top of the deck, then flips the first discard. Non-number cards
 * flipped as the first discard go to the bottom of the draw pile.
 */
export function createGame(options: CreateGameOptions): PlayingState {
  const activeSeats = validateActiveSeats(options.activeSeats);
  if (!activeSeats.includes(options.firstSeat)) {
    throw new Error(`firstSeat ${options.firstSeat} is not in activeSeats`);
  }
  const deck = options.shuffledDeck;
  if (deck.length !== 108 || new Set(deck.map((c) => c.id)).size !== 108) {
    throw new Error(`createGame requires 108 distinct cards, got ${deck.length}`);
  }

  let hands = emptyHands();
  let cursor = 0;
  for (const seat of activeSeats) {
    hands = withHand(hands, seat, deck.slice(cursor, cursor + HAND_SIZE));
    cursor += HAND_SIZE;
  }

  // Remaining deck as a draw pile with its top at the end.
  const remaining = deck.slice(cursor).reverse();
  const setAside: Card[] = [];
  let first = remaining.pop()!;
  while (first.kind !== "number") {
    setAside.push(first);
    first = remaining.pop()!;
  }
  // Set-aside cards go to the bottom (front of the array).
  const drawPile = [...setAside.reverse(), ...remaining];

  return {
    phase: "playing",
    activeSeats,
    baseStake: options.baseStake,
    hands,
    drawPile,
    discardPile: [first],
    currentColor: first.color!,
    direction: 1,
    currentTurn: options.firstSeat,
    pendingDraw: null,
    unoVulnerable: null,
    unoCalled: [],
    lastEvents: [],
  };
}

export function topCard(state: GameState): Card {
  return state.discardPile[state.discardPile.length - 1];
}

/** True when `card` may be played on `top` under `currentColor`, ignoring the wild4 restriction. */
export function matches(card: Card, top: Card, currentColor: Color): boolean {
  if (isWild(card)) return true;
  if (card.color === currentColor) return true;
  if (isWild(top)) return false;
  if (card.kind !== top.kind) return false;
  return card.kind !== "number" || card.value === top.value;
}

/** Playable from `hand` right now, including the wild4 "no card of the current colour" rule. */
export function isPlayable(card: Card, hand: readonly Card[], top: Card, currentColor: Color): boolean {
  if (!matches(card, top, currentColor)) return false;
  if (card.kind === "wild4") {
    return !hand.some((c) => c.id !== card.id && c.color === currentColor);
  }
  return true;
}

export function nextSeat(activeSeats: readonly Seat[], from: Seat, direction: Direction): Seat {
  const index = activeSeats.indexOf(from);
  if (index < 0) throw new Error(`seat ${from} is not active`);
  const n = activeSeats.length;
  return activeSeats[(index + direction + n) % n];
}

export function applyAction(state: GameState, seat: Seat, action: Action, random: RandomSource): ApplyResult {
  if (state.phase !== "playing") return { ok: false, reason: "wrong-phase" };
  // Calling and catching are open to every active seat, whoever's turn it is.
  if (action.type === "callUno") return applyCallUno(state, seat);
  if (action.type === "catchUno") return applyCatchUno(state, seat, action.target, random);
  if (seat !== state.currentTurn) return { ok: false, reason: "not-your-turn" };
  switch (action.type) {
    case "play":
      return applyPlay(state, seat, action, random);
    case "draw":
      return applyDraw(state, seat, random);
    case "pass":
      return applyPass(state, seat);
  }
}

/** Called seats whose hand grew past one card drop off the list. */
function calledAfter(called: readonly Seat[], hands: Readonly<Record<Seat, readonly Card[]>>): readonly Seat[] {
  return called.filter((s) => hands[s].length <= 1);
}

function applyCallUno(state: PlayingState, seat: Seat): ApplyResult {
  if (state.hands[seat].length !== 1 || state.unoCalled.includes(seat)) {
    return { ok: false, reason: "cannot-call-uno" };
  }
  return {
    ok: true,
    state: {
      ...state,
      unoVulnerable: state.unoVulnerable === seat ? null : state.unoVulnerable,
      unoCalled: [...state.unoCalled, seat],
      lastEvents: [{ type: "called-uno", seat }],
    },
  };
}

function applyCatchUno(state: PlayingState, seat: Seat, target: Seat, random: RandomSource): ApplyResult {
  if (
    state.unoVulnerable === null ||
    state.unoVulnerable !== target ||
    target === seat ||
    !state.activeSeats.includes(seat)
  ) {
    return { ok: false, reason: "nothing-to-catch" };
  }
  const events: GameEvent[] = [{ type: "caught", seat: target, by: seat }];
  const drawn = drawCards(state, 2, random, events);
  const hands = withHand(state.hands, target, [...state.hands[target], ...drawn.cards]);
  events.push({ type: "drew", seat: target, count: drawn.cards.length });
  return {
    ok: true,
    state: {
      ...state,
      hands,
      drawPile: drawn.piles.drawPile,
      discardPile: drawn.piles.discardPile,
      unoVulnerable: null,
      unoCalled: calledAfter(state.unoCalled, hands),
      lastEvents: events,
    },
  };
}

interface Piles {
  readonly drawPile: readonly Card[];
  readonly discardPile: readonly Card[];
}

/**
 * Takes up to `count` cards off the draw pile, refilling it from the discard
 * pile (minus its top card) when empty. Returns fewer cards only when every
 * card is in a hand.
 */
function drawCards(
  piles: Piles,
  count: number,
  random: RandomSource,
  events: GameEvent[],
): { cards: Card[]; piles: Piles } {
  let drawPile = piles.drawPile.slice();
  let discardPile = piles.discardPile;
  const cards: Card[] = [];
  for (let i = 0; i < count; i++) {
    if (drawPile.length === 0) {
      if (discardPile.length <= 1) break;
      const top = discardPile[discardPile.length - 1];
      drawPile = shuffleDeck(discardPile.slice(0, -1), random);
      discardPile = [top];
      events.push({ type: "reshuffled", count: drawPile.length });
    }
    cards.push(drawPile.pop()!);
  }
  return { cards, piles: { drawPile, discardPile } };
}

function applyPlay(
  state: PlayingState,
  seat: Seat,
  action: Extract<Action, { type: "play" }>,
  random: RandomSource,
): ApplyResult {
  const hand = state.hands[seat];
  const card = hand.find((c) => c.id === action.cardId);
  if (!card) return { ok: false, reason: "cards-not-in-hand" };
  if (state.pendingDraw !== null && card.id !== state.pendingDraw) {
    return { ok: false, reason: "must-play-drawn-card" };
  }
  const top = topCard(state);
  if (!matches(card, top, state.currentColor)) return { ok: false, reason: "card-not-playable" };
  if (card.kind === "wild4" && hand.some((c) => c.id !== card.id && c.color === state.currentColor)) {
    return { ok: false, reason: "wild-draw-four-not-allowed" };
  }
  let color: Color;
  if (isWild(card)) {
    if (action.color === undefined) return { ok: false, reason: "color-required" };
    if (!COLORS.includes(action.color)) return { ok: false, reason: "invalid-color" };
    color = action.color;
  } else {
    color = card.color!;
  }

  const events: GameEvent[] = [{ type: "played", seat, card, color }];
  let hands = withHand(state.hands, seat, hand.filter((c) => c.id !== card.id));
  const oneLeft = hands[seat].length === 1;
  const called = oneLeft && action.uno === true;
  if (called) events.push({ type: "called-uno", seat });
  let piles: Piles = { drawPile: state.drawPile, discardPile: [...state.discardPile, card] };
  let direction = state.direction;
  const twoPlayer = state.activeSeats.length === 2;

  if (card.kind === "reverse") {
    direction = direction === 1 ? -1 : 1;
    events.push({ type: "reversed" });
  }
  let next = nextSeat(state.activeSeats, seat, direction);
  const penalty = card.kind === "draw2" ? 2 : card.kind === "wild4" ? 4 : 0;
  if (penalty > 0) {
    const drawn = drawCards(piles, penalty, random, events);
    piles = drawn.piles;
    hands = withHand(hands, next, [...hands[next], ...drawn.cards]);
    events.push({ type: "drew", seat: next, count: drawn.cards.length });
  }
  const skips = card.kind === "skip" || penalty > 0 || (card.kind === "reverse" && twoPlayer);
  if (skips) {
    events.push({ type: "skipped", seat: next });
    next = nextSeat(state.activeSeats, next, direction);
  }

  if (hands[seat].length === 0) {
    return { ok: true, state: finish(state, seat, hands, piles.discardPile, color, events) };
  }

  const unoCalled = calledAfter(called ? [...state.unoCalled, seat] : state.unoCalled, hands);

  return {
    ok: true,
    state: {
      ...state,
      hands,
      drawPile: piles.drawPile,
      discardPile: piles.discardPile,
      currentColor: color,
      direction,
      currentTurn: next,
      pendingDraw: null,
      unoVulnerable: oneLeft && !called ? seat : null,
      unoCalled,
      lastEvents: events,
    },
  };
}

function applyDraw(state: PlayingState, seat: Seat, random: RandomSource): ApplyResult {
  if (state.pendingDraw !== null) return { ok: false, reason: "already-drew" };
  const events: GameEvent[] = [];
  const drawn = drawCards(state, 1, random, events);
  const hand = [...state.hands[seat], ...drawn.cards];
  const hands = withHand(state.hands, seat, hand);
  events.push({ type: "drew", seat, count: drawn.cards.length });

  const card = drawn.cards[0];
  const playable = card !== undefined && isPlayable(card, hand, topCard(state), state.currentColor);
  return {
    ok: true,
    state: {
      ...state,
      hands,
      drawPile: drawn.piles.drawPile,
      discardPile: drawn.piles.discardPile,
      currentTurn: playable ? seat : nextSeat(state.activeSeats, seat, state.direction),
      pendingDraw: playable ? card.id : null,
      unoVulnerable: null,
      unoCalled: calledAfter(state.unoCalled, hands),
      lastEvents: events,
    },
  };
}

function applyPass(state: PlayingState, seat: Seat): ApplyResult {
  if (state.pendingDraw === null) return { ok: false, reason: "cannot-pass" };
  return {
    ok: true,
    state: {
      ...state,
      currentTurn: nextSeat(state.activeSeats, seat, state.direction),
      pendingDraw: null,
      unoVulnerable: null,
      lastEvents: [{ type: "passed", seat }],
    },
  };
}

export function handPoints(hand: readonly Card[]): number {
  return hand.reduce((sum, c) => sum + cardPoints(c), 0);
}

function finish(
  state: PlayingState,
  winner: Seat,
  hands: Readonly<Record<Seat, readonly Card[]>>,
  discardPile: readonly Card[],
  currentColor: Color,
  lastEvents: readonly GameEvent[],
): FinishedState {
  const points = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<Seat, number>;
  for (const seat of state.activeSeats) points[seat] = handPoints(hands[seat]);
  return {
    phase: "finished",
    activeSeats: state.activeSeats,
    baseStake: state.baseStake,
    winner,
    hands,
    points,
    discardPile,
    currentColor,
    lastEvents,
  };
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
  readonly topCard: Card;
  readonly currentColor: Color;
  readonly direction: Direction;
  readonly currentTurn: Seat;
  readonly drawPileCount: number;
  /** True while the current seat is deciding whether to play the card it just drew. */
  readonly awaitingDrawDecision: boolean;
  /** The drawn card's id, only when the viewer is the one deciding. */
  readonly pendingDraw: string | null;
  readonly unoVulnerable: Seat | null;
  readonly unoCalled: readonly Seat[];
  readonly lastEvents: readonly GameEvent[];
}

export type RedactedFinishedView = FinishedState & { readonly viewer: Seat };

export type RedactedView = RedactedPlayingView | RedactedFinishedView;

function handCountsOf(hands: Readonly<Record<Seat, readonly Card[]>>): Record<Seat, number> {
  return { 0: hands[0].length, 1: hands[1].length, 2: hands[2].length, 3: hands[3].length, 4: hands[4].length, 5: hands[5].length };
}

/** Per-seat view: only the viewer's hand is revealed mid-hand; every hand is public once finished. */
export function viewFor(state: GameState, viewer: Seat): RedactedView {
  if (state.phase === "finished") return { ...state, viewer };
  return {
    phase: "playing",
    viewer,
    activeSeats: state.activeSeats,
    baseStake: state.baseStake,
    hand: state.hands[viewer],
    handCounts: handCountsOf(state.hands),
    topCard: topCard(state),
    currentColor: state.currentColor,
    direction: state.direction,
    currentTurn: state.currentTurn,
    drawPileCount: state.drawPile.length,
    awaitingDrawDecision: state.pendingDraw !== null,
    pendingDraw: viewer === state.currentTurn ? state.pendingDraw : null,
    unoVulnerable: state.unoVulnerable,
    unoCalled: state.unoCalled,
    lastEvents: state.lastEvents,
  };
}

// --- Settlement ---------------------------------------------------------------

export type SeatDeltas = Readonly<Record<Seat, number>>;

/** Credits a loser pays for `points` left in hand at `stake`. */
export function paymentFor(points: number, stake: number): number {
  return Math.round((points * stake) / 10);
}

/**
 * Each loser pays round(points x baseStake / 10) to the winner. Absent seats
 * settle at 0. Deltas sum to zero.
 */
export function settle(state: FinishedState): SeatDeltas {
  const deltas = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as Record<Seat, number>;
  let pot = 0;
  for (const seat of state.activeSeats) {
    if (seat === state.winner) continue;
    const payment = paymentFor(state.points[seat], state.baseStake);
    deltas[seat] = -payment;
    pot += payment;
  }
  deltas[state.winner] = pot;
  return deltas;
}
