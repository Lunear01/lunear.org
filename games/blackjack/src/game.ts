import type { Card } from "./cards";

export type Seat = number;

export type Phase = "acting" | "finished";

/**
 * Every round bets exactly the table stake (doubled by a double down). There
 * is no per-hand stack — unlike poker, a blackjack seat's exposure per round
 * is bounded at 2 x stake by the rules themselves.
 */
export interface PlayerRoundState {
  readonly cards: readonly Card[];
  /** stake, or 2 x stake after a double down. */
  readonly bet: number;
  readonly doubled: boolean;
  /** No further decisions this round: stood, busted, reached 21, doubled, or dealt a natural. */
  readonly done: boolean;
}

interface RoundBase {
  /** Ascending seat order == acting order. Fixed for the whole round. */
  readonly seats: readonly Seat[];
  readonly stake: number;
  readonly players: Readonly<Record<Seat, PlayerRoundState>>;
}

export interface ActingState extends RoundBase {
  readonly phase: "acting";
  /** [up card, hole card] — the hole card is what viewFor redacts. */
  readonly dealerCards: readonly [Card, Card];
  readonly currentTurn: Seat;
  /** Seats still owed a decision, in acting order; toAct[0] === currentTurn. */
  readonly toAct: readonly Seat[];
  /** Cards not yet dealt. */
  readonly shoe: readonly Card[];
}

export type Outcome = "blackjack" | "win" | "push" | "lose";

export interface FinishedState extends RoundBase {
  readonly phase: "finished";
  /** The dealer's full hand, hole card included. */
  readonly dealerCards: readonly Card[];
  readonly outcomes: Readonly<Record<Seat, Outcome>>;
}

export type GameState = ActingState | FinishedState;

export type Action = { readonly type: "hit" } | { readonly type: "stand" } | { readonly type: "double" };

export type RejectionReason = "wrong-phase" | "not-your-turn" | "cannot-double";

export type ApplyResult =
  | { readonly ok: true; readonly state: GameState }
  | { readonly ok: false; readonly reason: RejectionReason };

/**
 * The theoretical maximum one round can draw is 132 cards (6 hands x a
 * 22-card bust ceiling), so a 156-card (3-deck) shoe can never run dry
 * mid-round. Production callers pass a full SHOE_DECKS shoe; tests may pad a
 * fixed prefix up to this floor.
 */
export const MIN_SHOE_CARDS = 156;

const MIN_SEATS = 1;
const MAX_SEATS = 5;
const MAX_SEAT_NUMBER = 4;
const DEALER_STANDS_AT = 17;

export interface CreateGameOptions {
  /** 1-5 seat numbers (integers 0-4), unique; need not be contiguous. */
  readonly seats: readonly Seat[];
  /** The per-seat bet for the round. */
  readonly stake: number;
  /** At least MIN_SHOE_CARDS cards, already shuffled by the caller (see shuffleCards / createSeededRandom in ./cards). */
  readonly shuffledShoe: readonly Card[];
}

// --- Hand values ---------------------------------------------------------------

export interface HandValue {
  readonly total: number;
  /** An ace is currently counted as 11 (the hand can absorb a 10 without busting). */
  readonly soft: boolean;
}

/** Best blackjack value: face cards 10, each ace 11 downgraded to 1 while the total busts. */
export function handValue(cards: readonly Card[]): HandValue {
  let total = 0;
  let elevens = 0;
  for (const card of cards) {
    if (card.rank === 14) {
      total += 11;
      elevens++;
    } else {
      total += Math.min(card.rank, 10);
    }
  }
  while (total > 21 && elevens > 0) {
    total -= 10;
    elevens--;
  }
  return { total, soft: elevens > 0 };
}

export function isBust(cards: readonly Card[]): boolean {
  return handValue(cards).total > 21;
}

/** A natural: 21 from the two dealt cards. Beats any drawn 21. */
export function isNatural(cards: readonly Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

// --- Creation -----------------------------------------------------------------

/**
 * Deals two cards to each seat (ascending, one block per seat — same block
 * dealing as poker's dealHoleCards) then two to the dealer, and returns the
 * round ready for the first decision. Returns a FinishedState immediately
 * when no decision exists: the dealer was dealt a natural, or every seat was
 * — callers must handle a round that is over at the deal.
 */
export function createGame(options: CreateGameOptions): GameState {
  const seats = options.seats.slice().sort((a, b) => a - b);
  if (seats.length < MIN_SEATS || seats.length > MAX_SEATS) {
    throw new Error(`createGame requires ${MIN_SEATS}-${MAX_SEATS} seats, got ${seats.length}`);
  }
  if (new Set(seats).size !== seats.length) {
    throw new Error("createGame: seats must be unique");
  }
  if (seats.some((s) => !Number.isInteger(s) || s < 0 || s > MAX_SEAT_NUMBER)) {
    throw new Error(`createGame: seat numbers must be integers in 0-${MAX_SEAT_NUMBER}`);
  }
  if (!Number.isInteger(options.stake) || options.stake < 1) {
    throw new Error("createGame: stake must be a positive integer");
  }
  if (options.shuffledShoe.length < MIN_SHOE_CARDS) {
    throw new Error(`createGame requires at least ${MIN_SHOE_CARDS} cards, got ${options.shuffledShoe.length}`);
  }

  const players: Record<Seat, PlayerRoundState> = {};
  seats.forEach((seat, i) => {
    const cards = [options.shuffledShoe[i * 2], options.shuffledShoe[i * 2 + 1]] as const;
    players[seat] = { cards, bet: options.stake, doubled: false, done: isNatural(cards) };
  });
  const dealerCards: readonly [Card, Card] = [
    options.shuffledShoe[seats.length * 2],
    options.shuffledShoe[seats.length * 2 + 1],
  ];
  const shoe = options.shuffledShoe.slice(seats.length * 2 + 2);

  // A dealer natural ends the round before anyone acts (no insurance offer in
  // this build); so does a table of nothing but player naturals.
  const toAct = isNatural(dealerCards) ? [] : seats.filter((s) => !players[s].done);
  if (toAct.length === 0) {
    return finishRound(seats, options.stake, players, dealerCards, shoe);
  }

  return {
    phase: "acting",
    seats,
    stake: options.stake,
    players,
    dealerCards,
    currentTurn: toAct[0],
    toAct,
    shoe,
  };
}

// --- Actions --------------------------------------------------------------------

export function applyAction(state: GameState, seat: Seat, action: Action): ApplyResult {
  if (state.phase === "finished") return { ok: false, reason: "wrong-phase" };
  if (!state.players[seat] || seat !== state.currentTurn) return { ok: false, reason: "not-your-turn" };

  const player = state.players[seat];
  switch (action.type) {
    case "hit": {
      const cards = [...player.cards, state.shoe[0]];
      // Reaching 21 (or busting) ends the turn automatically — there is no
      // decision left a hit or stand could change.
      const done = handValue(cards).total >= 21;
      return { ok: true, state: afterPlayerUpdate(state, seat, { ...player, cards, done }, state.shoe.slice(1)) };
    }
    case "stand":
      return { ok: true, state: afterPlayerUpdate(state, seat, { ...player, done: true }, state.shoe) };
    case "double": {
      // Only from the two dealt cards — a hit forfeits the option.
      if (player.cards.length !== 2) return { ok: false, reason: "cannot-double" };
      const cards = [...player.cards, state.shoe[0]];
      const updated = { ...player, cards, bet: player.bet * 2, doubled: true, done: true };
      return { ok: true, state: afterPlayerUpdate(state, seat, updated, state.shoe.slice(1)) };
    }
  }
}

/** Advance past `seat` if it's done (a non-terminal hit keeps the turn); dealer plays once nobody's left. */
function afterPlayerUpdate(
  state: ActingState,
  seat: Seat,
  updated: PlayerRoundState,
  shoe: readonly Card[],
): GameState {
  const players = { ...state.players, [seat]: updated };
  const toAct = updated.done ? state.toAct.filter((s) => s !== seat) : state.toAct;
  if (toAct.length === 0) {
    return finishRound(state.seats, state.stake, players, state.dealerCards, shoe);
  }
  return { ...state, players, shoe, toAct, currentTurn: toAct[0] };
}

/**
 * Reveals the hole card, draws the dealer to DEALER_STANDS_AT+ (standing on
 * all 17s, soft included), and scores every seat. The dealer only draws when
 * at least one seat still needs beating — every seat busted or holding a
 * natural means the outcomes are already decided, matching table practice.
 */
function finishRound(
  seats: readonly Seat[],
  stake: number,
  players: Readonly<Record<Seat, PlayerRoundState>>,
  dealerStart: readonly [Card, Card],
  shoe: readonly Card[],
): FinishedState {
  const dealerCards: Card[] = [...dealerStart];
  const anyToBeat = seats.some((s) => !isBust(players[s].cards) && !isNatural(players[s].cards));
  if (anyToBeat && !isNatural(dealerCards)) {
    let drawFrom = 0;
    while (handValue(dealerCards).total < DEALER_STANDS_AT) {
      dealerCards.push(shoe[drawFrom++]);
    }
  }

  const outcomes: Record<Seat, Outcome> = {};
  for (const seat of seats) {
    outcomes[seat] = outcomeFor(players[seat].cards, dealerCards);
  }
  return { phase: "finished", seats, stake, players, dealerCards, outcomes };
}

/** A bust loses even to a dealer bust; a dealer natural beats everything but pushes a player natural. */
function outcomeFor(playerCards: readonly Card[], dealerCards: readonly Card[]): Outcome {
  const player = handValue(playerCards).total;
  if (player > 21) return "lose";
  if (isNatural(playerCards)) return isNatural(dealerCards) ? "push" : "blackjack";
  if (isNatural(dealerCards)) return "lose";
  const dealer = handValue(dealerCards).total;
  if (dealer > 21 || player > dealer) return "win";
  if (player < dealer) return "lose";
  return "push";
}

// --- Redacted per-seat views ------------------------------------------------------

/**
 * All player hands are public in blackjack (cards land face up), so unlike
 * poker every seat's full cards appear in everyone's view; the only redacted
 * fact is the dealer's hole card while the round is still being acted.
 * Totals are computed here so clients never reimplement ace math.
 */
export interface PublicHandStatus {
  readonly cards: readonly Card[];
  readonly bet: number;
  readonly doubled: boolean;
  readonly done: boolean;
  readonly total: number;
  readonly soft: boolean;
  readonly busted: boolean;
  readonly natural: boolean;
}

export interface RedactedActingView {
  readonly phase: "acting";
  readonly viewer: Seat;
  readonly seats: readonly Seat[];
  readonly stake: number;
  readonly dealerUpCard: Card;
  readonly currentTurn: Seat;
  readonly players: Readonly<Record<Seat, PublicHandStatus>>;
}

export interface RedactedFinishedView {
  readonly phase: "finished";
  readonly viewer: Seat;
  readonly seats: readonly Seat[];
  readonly stake: number;
  readonly dealerCards: readonly Card[];
  readonly dealerTotal: number;
  readonly dealerBusted: boolean;
  readonly outcomes: Readonly<Record<Seat, Outcome>>;
  readonly players: Readonly<Record<Seat, PublicHandStatus>>;
}

export type RedactedView = RedactedActingView | RedactedFinishedView;

function publicHandStatus(players: Readonly<Record<Seat, PlayerRoundState>>, seats: readonly Seat[]) {
  const out: Record<Seat, PublicHandStatus> = {};
  for (const seat of seats) {
    const p = players[seat];
    const value = handValue(p.cards);
    out[seat] = {
      cards: p.cards,
      bet: p.bet,
      doubled: p.doubled,
      done: p.done,
      total: value.total,
      soft: value.soft,
      busted: value.total > 21,
      natural: isNatural(p.cards),
    };
  }
  return out;
}

/**
 * Safe for any `viewer` seat number, dealt into the round or not — nothing
 * here indexes players[viewer], so a spectating (skipped) seat can call this
 * in either phase.
 */
export function viewFor(state: GameState, viewer: Seat): RedactedView {
  if (state.phase === "finished") {
    const dealer = handValue(state.dealerCards);
    return {
      phase: "finished",
      viewer,
      seats: state.seats,
      stake: state.stake,
      dealerCards: state.dealerCards,
      dealerTotal: dealer.total,
      dealerBusted: dealer.total > 21,
      outcomes: state.outcomes,
      players: publicHandStatus(state.players, state.seats),
    };
  }
  return {
    phase: "acting",
    viewer,
    seats: state.seats,
    stake: state.stake,
    dealerUpCard: state.dealerCards[0],
    currentTurn: state.currentTurn,
    players: publicHandStatus(state.players, state.seats),
  };
}

// --- Settlement ---------------------------------------------------------------

export type SeatDeltas = Readonly<Record<Seat, number>>;

/**
 * Per-seat signed delta against the house: win +bet, lose -bet, push 0, and a
 * natural pays 3:2 (+floor(1.5 x bet)). NOT zero-sum — the house absorbs the
 * balance; the platform's credit ledger records per-user deltas only, so no
 * counterparty row is needed.
 */
export function settle(state: FinishedState): SeatDeltas {
  const deltas: Record<Seat, number> = {};
  for (const seat of state.seats) {
    const bet = state.players[seat].bet;
    switch (state.outcomes[seat]) {
      case "blackjack":
        deltas[seat] = Math.floor(1.5 * bet);
        break;
      case "win":
        deltas[seat] = bet;
        break;
      case "push":
        deltas[seat] = 0;
        break;
      case "lose":
        deltas[seat] = -bet;
        break;
    }
  }
  return deltas;
}
