import type { Card } from "./cards";

export type Seat = number;

export type Phase = "acting" | "finished";

/** One wagered hand. A seat holds one, or two after a split. */
export interface HandState {
  readonly cards: readonly Card[];
  /** The seat's chosen bet, doubled by a double down. Each split hand carries its own. */
  readonly bet: number;
  readonly doubled: boolean;
  /** No further decisions: stood, busted, reached 21, doubled, dealt a natural, or a split ace. */
  readonly done: boolean;
  /** Came from a split — a two-card 21 here is a plain 21, not a natural. */
  readonly fromSplit: boolean;
}

export interface PlayerRoundState {
  readonly hands: readonly HandState[];
  /** Index into `hands` of the hand awaiting a decision. Meaningless once every hand is done. */
  readonly activeHand: number;
}

interface RoundBase {
  /** Ascending seat order == acting order. Fixed for the whole round. */
  readonly seats: readonly Seat[];
  /** Table minimum bet. */
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
  /** Index-aligned with players[seat].hands. */
  readonly outcomes: Readonly<Record<Seat, readonly Outcome[]>>;
}

export type GameState = ActingState | FinishedState;

export type Action =
  | { readonly type: "hit" }
  | { readonly type: "stand" }
  | { readonly type: "double" }
  | { readonly type: "split" };

export type RejectionReason = "wrong-phase" | "not-your-turn" | "cannot-double" | "cannot-split";

export type ApplyResult =
  | { readonly ok: true; readonly state: GameState }
  | { readonly ok: false; readonly reason: RejectionReason };

/**
 * A round draws at most 132 cards: 11 hands (5 seats, each split once, plus
 * the dealer) x a 12-card bust ceiling. A 156-card (3-deck) shoe can never
 * run dry mid-round. Production callers pass a full SHOE_DECKS shoe; tests
 * may pad a fixed prefix up to this floor.
 */
export const MIN_SHOE_CARDS = 156;

const MIN_SEATS = 1;
const MAX_SEATS = 5;
const MAX_SEAT_NUMBER = 4;
const DEALER_STANDS_AT = 17;

export interface CreateGameOptions {
  /** 1-5 seat numbers (integers 0-4), unique; need not be contiguous. */
  readonly seats: readonly Seat[];
  /** Table minimum bet; also the default bet for any seat missing from `bets`. */
  readonly stake: number;
  /** Per-seat bet for the round, each an integer >= stake. */
  readonly bets?: Readonly<Partial<Record<Seat, number>>>;
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

/** A natural: 21 from the two dealt cards. Beats any drawn 21. Split hands never qualify — see isNaturalHand. */
export function isNatural(cards: readonly Card[]): boolean {
  return cards.length === 2 && handValue(cards).total === 21;
}

export function isNaturalHand(hand: HandState): boolean {
  return !hand.fromSplit && isNatural(hand.cards);
}

/** Rank class for pairing: faces and tens all count as 10, an ace pairs only with an ace. */
function splitRank(card: Card): number {
  return card.rank >= 10 && card.rank <= 13 ? 10 : card.rank;
}

/** One split per round, from an unsplit two-card hand of equal-value cards. */
export function canSplit(player: PlayerRoundState): boolean {
  if (player.hands.length !== 1) return false;
  const hand = player.hands[0];
  return !hand.done && hand.cards.length === 2 && splitRank(hand.cards[0]) === splitRank(hand.cards[1]);
}

function seatDone(player: PlayerRoundState): boolean {
  return player.hands.every((h) => h.done);
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
  for (const seat of seats) {
    const bet = options.bets?.[seat];
    if (bet !== undefined && (!Number.isInteger(bet) || bet < options.stake)) {
      throw new Error(`createGame: seat ${seat}'s bet must be an integer >= stake (${options.stake}), got ${bet}`);
    }
  }
  if (options.shuffledShoe.length < MIN_SHOE_CARDS) {
    throw new Error(`createGame requires at least ${MIN_SHOE_CARDS} cards, got ${options.shuffledShoe.length}`);
  }

  const players: Record<Seat, PlayerRoundState> = {};
  seats.forEach((seat, i) => {
    const cards = [options.shuffledShoe[i * 2], options.shuffledShoe[i * 2 + 1]] as const;
    const bet = options.bets?.[seat] ?? options.stake;
    players[seat] = {
      hands: [{ cards, bet, doubled: false, done: isNatural(cards), fromSplit: false }],
      activeHand: 0,
    };
  });
  const dealerCards: readonly [Card, Card] = [
    options.shuffledShoe[seats.length * 2],
    options.shuffledShoe[seats.length * 2 + 1],
  ];
  const shoe = options.shuffledShoe.slice(seats.length * 2 + 2);

  // A dealer natural ends the round before anyone acts (no insurance offer in
  // this build); so does a table of nothing but player naturals.
  const toAct = isNatural(dealerCards) ? [] : seats.filter((s) => !seatDone(players[s]));
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
  const hand = player.hands[player.activeHand];
  switch (action.type) {
    case "hit": {
      const cards = [...hand.cards, state.shoe[0]];
      // Reaching 21 (or busting) ends the hand automatically — there is no
      // decision left a hit or stand could change.
      const done = handValue(cards).total >= 21;
      return { ok: true, state: afterHandUpdate(state, seat, { ...hand, cards, done }, state.shoe.slice(1)) };
    }
    case "stand":
      return { ok: true, state: afterHandUpdate(state, seat, { ...hand, done: true }, state.shoe) };
    case "double": {
      // Allowed on any hand still awaiting a decision, however many cards it holds.
      if (hand.done) return { ok: false, reason: "cannot-double" };
      const cards = [...hand.cards, state.shoe[0]];
      const updated = { ...hand, cards, bet: hand.bet * 2, doubled: true, done: true };
      return { ok: true, state: afterHandUpdate(state, seat, updated, state.shoe.slice(1)) };
    }
    case "split": {
      if (!canSplit(player)) return { ok: false, reason: "cannot-split" };
      // Split aces take one card each and stop; any other split hand plays on.
      const aces = hand.cards[0].rank === 14;
      const half = (first: Card, drawn: Card): HandState => {
        const cards = [first, drawn];
        return { cards, bet: hand.bet, doubled: false, done: aces || handValue(cards).total >= 21, fromSplit: true };
      };
      const hands = [half(hand.cards[0], state.shoe[0]), half(hand.cards[1], state.shoe[1])];
      return { ok: true, state: afterPlayerUpdate(state, seat, { hands, activeHand: 0 }, state.shoe.slice(2)) };
    }
  }
}

function afterHandUpdate(state: ActingState, seat: Seat, hand: HandState, shoe: readonly Card[]): GameState {
  const player = state.players[seat];
  const hands = player.hands.map((h, i) => (i === player.activeHand ? hand : h));
  return afterPlayerUpdate(state, seat, { ...player, hands }, shoe);
}

/**
 * Moves the seat on to its next undone hand, or past the seat entirely once
 * every hand is done; the dealer plays once nobody's left.
 */
function afterPlayerUpdate(
  state: ActingState,
  seat: Seat,
  updated: PlayerRoundState,
  shoe: readonly Card[],
): GameState {
  const nextHand = updated.hands.findIndex((h) => !h.done);
  const player = nextHand === -1 ? updated : { ...updated, activeHand: nextHand };
  const players = { ...state.players, [seat]: player };
  const toAct = nextHand === -1 ? state.toAct.filter((s) => s !== seat) : state.toAct;
  if (toAct.length === 0) {
    return finishRound(state.seats, state.stake, players, state.dealerCards, shoe);
  }
  return { ...state, players, shoe, toAct, currentTurn: toAct[0] };
}

/**
 * Reveals the hole card, draws the dealer to DEALER_STANDS_AT+ (standing on
 * all 17s, soft included), and scores every hand. The dealer only draws when
 * at least one hand still needs beating — every hand busted or a natural
 * means the outcomes are already decided, matching table practice.
 */
function finishRound(
  seats: readonly Seat[],
  stake: number,
  players: Readonly<Record<Seat, PlayerRoundState>>,
  dealerStart: readonly [Card, Card],
  shoe: readonly Card[],
): FinishedState {
  const dealerCards: Card[] = [...dealerStart];
  const anyToBeat = seats.some((s) => players[s].hands.some((h) => !isBust(h.cards) && !isNaturalHand(h)));
  if (anyToBeat && !isNatural(dealerCards)) {
    let drawFrom = 0;
    while (handValue(dealerCards).total < DEALER_STANDS_AT) {
      dealerCards.push(shoe[drawFrom++]);
    }
  }

  const outcomes: Record<Seat, readonly Outcome[]> = {};
  for (const seat of seats) {
    outcomes[seat] = players[seat].hands.map((h) => outcomeFor(h, dealerCards));
  }
  return { phase: "finished", seats, stake, players, dealerCards, outcomes };
}

/** A bust loses even to a dealer bust; a dealer natural beats everything but pushes a player natural. */
function outcomeFor(hand: HandState, dealerCards: readonly Card[]): Outcome {
  const player = handValue(hand.cards).total;
  if (player > 21) return "lose";
  if (isNaturalHand(hand)) return isNatural(dealerCards) ? "push" : "blackjack";
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
  readonly fromSplit: boolean;
  readonly total: number;
  readonly soft: boolean;
  readonly busted: boolean;
  readonly natural: boolean;
}

export interface PublicPlayerStatus {
  readonly hands: readonly PublicHandStatus[];
  readonly activeHand: number;
  /** Rule check for the split action; only actionable on this seat's turn. */
  readonly canSplit: boolean;
  /** Sum of every hand's bet. */
  readonly totalBet: number;
}

export interface RedactedActingView {
  readonly phase: "acting";
  readonly viewer: Seat;
  readonly seats: readonly Seat[];
  readonly stake: number;
  readonly dealerUpCard: Card;
  readonly currentTurn: Seat;
  readonly players: Readonly<Record<Seat, PublicPlayerStatus>>;
}

export interface RedactedFinishedView {
  readonly phase: "finished";
  readonly viewer: Seat;
  readonly seats: readonly Seat[];
  readonly stake: number;
  readonly dealerCards: readonly Card[];
  readonly dealerTotal: number;
  readonly dealerBusted: boolean;
  readonly outcomes: Readonly<Record<Seat, readonly Outcome[]>>;
  readonly players: Readonly<Record<Seat, PublicPlayerStatus>>;
}

export type RedactedView = RedactedActingView | RedactedFinishedView;

function publicHandStatus(hand: HandState): PublicHandStatus {
  const value = handValue(hand.cards);
  return {
    cards: hand.cards,
    bet: hand.bet,
    doubled: hand.doubled,
    done: hand.done,
    fromSplit: hand.fromSplit,
    total: value.total,
    soft: value.soft,
    busted: value.total > 21,
    natural: isNaturalHand(hand),
  };
}

function publicPlayers(players: Readonly<Record<Seat, PlayerRoundState>>, seats: readonly Seat[]) {
  const out: Record<Seat, PublicPlayerStatus> = {};
  for (const seat of seats) {
    const p = players[seat];
    out[seat] = {
      hands: p.hands.map(publicHandStatus),
      activeHand: p.activeHand,
      canSplit: canSplit(p),
      totalBet: p.hands.reduce((sum, h) => sum + h.bet, 0),
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
      players: publicPlayers(state.players, state.seats),
    };
  }
  return {
    phase: "acting",
    viewer,
    seats: state.seats,
    stake: state.stake,
    dealerUpCard: state.dealerCards[0],
    currentTurn: state.currentTurn,
    players: publicPlayers(state.players, state.seats),
  };
}

// --- Settlement ---------------------------------------------------------------

export type SeatDeltas = Readonly<Record<Seat, number>>;

/**
 * Per-seat signed delta against the house, summed over the seat's hands:
 * win +bet, lose -bet, push 0, and a natural pays 3:2 (+floor(1.5 x bet)).
 * NOT zero-sum — the house absorbs the balance; the platform's credit ledger
 * records per-user deltas only, so no counterparty row is needed.
 */
export function settle(state: FinishedState): SeatDeltas {
  const deltas: Record<Seat, number> = {};
  for (const seat of state.seats) {
    let total = 0;
    state.players[seat].hands.forEach((hand, i) => {
      switch (state.outcomes[seat][i]) {
        case "blackjack":
          total += Math.floor(1.5 * hand.bet);
          break;
        case "win":
          total += hand.bet;
          break;
        case "push":
          break;
        case "lose":
          total -= hand.bet;
          break;
      }
    });
    deltas[seat] = total;
  }
  return deltas;
}
