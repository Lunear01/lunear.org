// UNO card model. Its own deck, not the poker one: four colours, number
// cards 0-9, three action kinds per colour, and two colourless wild kinds.
export type Color = "red" | "yellow" | "green" | "blue";
export const COLORS: readonly Color[] = ["red", "yellow", "green", "blue"];

export type Kind = "number" | "skip" | "reverse" | "draw2" | "wild" | "wild4";

export interface Card {
  readonly id: string;
  /** null for wild and wild4. */
  readonly color: Color | null;
  readonly kind: Kind;
  /** 0-9 for a number card, null otherwise. */
  readonly value: number | null;
}

const COLOR_LETTER: Record<Color, string> = { red: "r", yellow: "y", green: "g", blue: "b" };
const ACTION_LETTER: Record<Exclude<Kind, "number" | "wild" | "wild4">, string> = {
  skip: "S",
  reverse: "R",
  draw2: "D",
};

export const DECK_SIZE = 108;

/**
 * Fixed-order 108-card deck: per colour one 0, two each of 1-9, two skips,
 * two reverses, two draw-twos; four wilds, four wild-draw-fours. Caller shuffles.
 */
export function createDeck(): Card[] {
  const deck: Card[] = [];
  for (const color of COLORS) {
    const c = COLOR_LETTER[color];
    deck.push({ id: `${c}0`, color, kind: "number", value: 0 });
    for (let value = 1; value <= 9; value++) {
      deck.push({ id: `${c}${value}a`, color, kind: "number", value });
      deck.push({ id: `${c}${value}b`, color, kind: "number", value });
    }
    for (const kind of ["skip", "reverse", "draw2"] as const) {
      deck.push({ id: `${c}${ACTION_LETTER[kind]}a`, color, kind, value: null });
      deck.push({ id: `${c}${ACTION_LETTER[kind]}b`, color, kind, value: null });
    }
  }
  for (const copy of ["a", "b", "c", "d"]) {
    deck.push({ id: `W${copy}`, color: null, kind: "wild", value: null });
  }
  for (const copy of ["a", "b", "c", "d"]) {
    deck.push({ id: `W4${copy}`, color: null, kind: "wild4", value: null });
  }
  return deck;
}

export function isWild(card: Card): boolean {
  return card.kind === "wild" || card.kind === "wild4";
}

/** Scoring value of a card left in a losing hand. */
export function cardPoints(card: Card): number {
  switch (card.kind) {
    case "number":
      return card.value ?? 0;
    case "skip":
    case "reverse":
    case "draw2":
      return 20;
    case "wild":
    case "wild4":
      return 50;
  }
}

/** Signature-compatible with Math.random: returns a float in [0, 1). */
export type RandomSource = () => number;

/** Fisher-Yates shuffle driven by a caller-supplied RNG. Does not mutate `deck`. */
export function shuffleDeck(deck: readonly Card[], random: RandomSource): Card[] {
  const result = deck.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    const tmp = result[i];
    result[i] = result[j];
    result[j] = tmp;
  }
  return result;
}

/** Deterministic seeded RNG (mulberry32) for reproducible shuffles in tests and replays. */
export function createSeededRandom(seed: number): RandomSource {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const COLOR_ORDER: Record<Color, number> = { red: 0, yellow: 1, green: 2, blue: 3 };
const KIND_ORDER: Record<Kind, number> = { number: 0, skip: 1, reverse: 2, draw2: 3, wild: 4, wild4: 5 };

/** Stable hand ordering: colour groups, numbers ascending, actions after numbers, wilds last. */
export function sortHand(cards: readonly Card[]): Card[] {
  return cards.slice().sort((a, b) => {
    const ca = a.color === null ? 4 : COLOR_ORDER[a.color];
    const cb = b.color === null ? 4 : COLOR_ORDER[b.color];
    if (ca !== cb) return ca - cb;
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return (a.value ?? 0) - (b.value ?? 0) || a.id.localeCompare(b.id);
  });
}
