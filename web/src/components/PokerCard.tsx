import type { Card } from "../ws/poker-types";

// Poker's Card shape (rank 2-14, suit "c"|"d"|"h"|"s" — games/poker/src/cards.ts)
// is incompatible with doudizhu's Card (numeric rank 3-17 incl. jokers, suit
// "S"|"H"|"D"|"C"|"JOKER" — web/src/ws/cards.ts's rankLabel/suitGlyph), so
// this is a sibling of LiarsBarCard rather than an extension of the existing
// PlayingCard: same reasoning as that component's doc comment in
// web/src/pages/LiarsBarTable.tsx's project memory — reuse the `.playing-card`
// CSS as-is, only the rank/suit glyph lookup differs. No joker variant needed
// (a hold'em deck has none).
const RANK_LABELS: Record<number, string> = {
  2: "2",
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
};

const SUIT_GLYPHS: Record<Card["suit"], string> = { c: "♣", d: "♦", h: "♥", s: "♠" };

function isRed(card: Card): boolean {
  return card.suit === "d" || card.suit === "h";
}

interface PokerCardProps {
  card: Card;
  /** Renders large, for the viewer's own hole cards (see .pk-holecard in global.css). */
  big?: boolean;
}

export function PokerCard({ card, big = false }: PokerCardProps) {
  const classes = ["playing-card", isRed(card) ? "playing-card--red" : "playing-card--black", big && "pk-holecard"]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes} aria-label={`${RANK_LABELS[card.rank]} of ${SUIT_GLYPHS[card.suit]}`}>
      <span className="playing-card__index" aria-hidden="true">
        <span className="playing-card__rank">{RANK_LABELS[card.rank]}</span>
        <span className="playing-card__suit">{SUIT_GLYPHS[card.suit]}</span>
      </span>
      <span className="playing-card__pip" aria-hidden="true">
        {SUIT_GLYPHS[card.suit]}
      </span>
    </div>
  );
}

/** An undealt community-card slot: an empty outline, distinct from a face-down
 * CardBack (which implies a hidden-but-real card — never true for the board). */
export function PokerCardSlot({ big = false }: { big?: boolean }) {
  return <div className={`pk-cardslot ${big ? "pk-holecard" : ""}`} aria-hidden="true" />;
}
