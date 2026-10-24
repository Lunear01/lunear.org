import { cardValue, type Card } from "./cards";
import { beats, classifyCombo, fiveCardRank, type Combo } from "./combos";

function totalValue(combo: Combo): number {
  return combo.cards.reduce((sum, c) => sum + cardValue(c), 0);
}

/** Weakest-first order among combos of one card count; equal strength prefers lower-suited cards. */
function weaker(a: Combo, b: Combo): number {
  return (
    fiveCardRank(a.category) - fiveCardRank(b.category) || a.strength - b.strength || totalValue(a) - totalValue(b)
  );
}

function* choose(cards: readonly Card[], k: number, start = 0, picked: Card[] = []): Generator<Card[]> {
  if (picked.length === k) {
    yield picked.slice();
    return;
  }
  for (let i = start; i <= cards.length - (k - picked.length); i++) {
    picked.push(cards[i]);
    yield* choose(cards, k, i + 1, picked);
    picked.pop();
  }
}

/** Every legal combo of `size` cards in `hand`. Same-rank shapes come from rank groups; five-card hands from all 5-subsets. */
function combosOfSize(hand: readonly Card[], size: number): Combo[] {
  const found: Combo[] = [];
  if (size === 5) {
    for (const pick of choose(hand, 5)) {
      const combo = classifyCombo(pick);
      if (combo) found.push(combo);
    }
    return found;
  }
  const byRank = new Map<number, Card[]>();
  for (const card of hand) byRank.set(card.rank, [...(byRank.get(card.rank) ?? []), card]);
  for (const group of byRank.values()) {
    if (group.length < size) continue;
    for (const pick of choose(group, size)) {
      const combo = classifyCombo(pick);
      if (combo) found.push(combo);
    }
  }
  return found;
}

/**
 * Weakest legal play. With `toBeat`, the weakest same-count combo that beats
 * it, or null when none does. On a free lead, the weakest single; when the
 * first-play rule is live, the lead card itself.
 */
export function suggestPlay(hand: readonly Card[], toBeat: Combo | null, leadCardId: string | null): Card[] | null {
  if (hand.length === 0) return null;
  if (toBeat === null) {
    const lead = leadCardId === null ? undefined : hand.find((c) => c.id === leadCardId);
    if (lead) return [lead];
    return [hand.reduce((low, c) => (cardValue(c) < cardValue(low) ? c : low))];
  }
  const size = toBeat.cards.length;
  if (hand.length < size) return null;
  const candidates = combosOfSize(hand, size).filter((c) => beats(toBeat, c));
  if (candidates.length === 0) return null;
  candidates.sort(weaker);
  return [...candidates[0].cards];
}
