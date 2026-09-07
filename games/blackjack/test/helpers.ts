import { createShoe, type Card } from "../src/cards";
import { applyAction, MIN_SHOE_CARDS, type Action, type GameState, type Seat } from "../src/game";

// Shoe cards carry a deck index in their id ("As#2"), so tests name cards by
// plain label ("As") and this pool hands out the next unused instance —
// naming the same label twice yields two distinct shoe cards.
class CardPool {
  private readonly byLabel = new Map<string, Card[]>();

  constructor() {
    for (const card of createShoe(3)) {
      const label = card.id.slice(0, card.id.indexOf("#"));
      const list = this.byLabel.get(label) ?? [];
      list.push(card);
      this.byLabel.set(label, list);
    }
  }

  take(label: string): Card {
    const list = this.byLabel.get(label);
    const card = list?.shift();
    if (!card) throw new Error(`test card pool exhausted or unknown label: ${label}`);
    return card;
  }

  rest(): Card[] {
    return [...this.byLabel.values()].flat();
  }
}

export interface ShoeScript {
  /** Two dealt cards per seat, keyed by real seat number. Every seat in `seats` must appear. */
  readonly hands: Readonly<Record<Seat, readonly [string, string]>>;
  readonly dealer: readonly [string, string];
  /** Every card drawn after the deal — player hits/doubles first (in action order), then dealer draws. */
  readonly draws?: readonly string[];
}

/**
 * Build a full test shoe from named hands: seat blocks in ascending seat
 * order, dealer's two, then `draws` in draw order — exactly createGame's and
 * the action handlers' consumption order — padded past MIN_SHOE_CARDS with
 * the pool's unused cards.
 */
export function buildShoe(seats: readonly Seat[], script: ShoeScript): Card[] {
  const pool = new CardPool();
  const sorted = seats.slice().sort((a, b) => a - b);
  const order: Card[] = [];
  for (const seat of sorted) {
    const pair = script.hands[seat];
    if (!pair) throw new Error(`buildShoe: no hand for seat ${seat}`);
    order.push(pool.take(pair[0]), pool.take(pair[1]));
  }
  order.push(pool.take(script.dealer[0]), pool.take(script.dealer[1]));
  for (const label of script.draws ?? []) order.push(pool.take(label));

  const shoe = [...order, ...pool.rest()];
  if (shoe.length < MIN_SHOE_CARDS) throw new Error(`buildShoe internal error: only ${shoe.length} cards`);
  return shoe;
}

/** Apply an action, throwing with the rejection reason if it's unexpectedly refused. */
export function act(state: GameState, seat: Seat, action: Action): GameState {
  const result = applyAction(state, seat, action);
  if (!result.ok) {
    throw new Error(`applyAction rejected: ${result.reason} (seat ${seat}, ${JSON.stringify(action)})`);
  }
  return result.state;
}

/** Apply an action and assert it was rejected with the given reason. */
export function expectRejected(state: GameState, seat: Seat, action: Action, reason: string): void {
  const result = applyAction(state, seat, action);
  if (result.ok) throw new Error(`expected rejection "${reason}" but action succeeded`);
  if (result.reason !== reason) throw new Error(`expected rejection "${reason}" but got "${result.reason}"`);
}

export function labelsOf(cards: readonly Card[]): string[] {
  return cards.map((c) => c.id.slice(0, c.id.indexOf("#")));
}
