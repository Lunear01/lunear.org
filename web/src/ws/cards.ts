// Small display helpers for games/doudizhu's Card shape (id/rank/suit — see
// games/doudizhu/src/cards.ts). Kept local rather than importing the
// engine's own rank-label table (unexported, and this is presentation-only).
import type { Card } from "./types";

const RANK_LABELS: Record<number, string> = {
  3: "3",
  4: "4",
  5: "5",
  6: "6",
  7: "7",
  8: "8",
  9: "9",
  10: "10",
  11: "J",
  12: "Q",
  13: "K",
  14: "A",
  15: "2",
  16: "B",
  17: "R",
};

export function rankLabel(rank: number): string {
  return RANK_LABELS[rank] ?? String(rank);
}

export function isJoker(card: Card): boolean {
  return card.suit === "JOKER";
}

export function isRed(card: Card): boolean {
  return card.suit === "H" || card.suit === "D";
}

const SUIT_GLYPHS: Record<string, string> = { S: "♠", H: "♥", D: "♦", C: "♣" };

export function suitGlyph(card: Card): string {
  return SUIT_GLYPHS[card.suit] ?? "";
}

/** Stable hand ordering: rank ascending, suit as a tiebreaker. */
export function sortForHand(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => a.rank - b.rank || a.suit.localeCompare(b.suit));
}
