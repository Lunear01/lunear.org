import type { Card } from "../ws/liarsbar-types";

interface LiarsBarCardProps {
  card: Card;
  selected?: boolean;
  small?: boolean;
  /** Omit to render a non-interactive (revealed/history) card. */
  onClick?: () => void;
}

/**
 * Liar's Bar's own card face — kept separate from PlayingCard (doudizhu's)
 * rather than extending it: liarsbar's Card has no suit and a string rank
 * (Q/K/A/JOKER, see games/liarsbar/src/cards.ts) where doudizhu's is a
 * numeric rank + suit, so there's no clean shared prop shape between them.
 * Reuses the existing `.playing-card`/`.playing-card__index`/
 * `.playing-card__pip`/`.playing-card--joker` CSS (sizing, fan-overlap,
 * selection lift) as-is — only the rank glyph markup differs, so no new
 * card-face CSS was needed.
 */
export function LiarsBarCard({ card, selected = false, small = false, onClick }: LiarsBarCardProps) {
  const isJoker = card.rank === "JOKER";
  const classes = [
    "playing-card",
    small && "playing-card--small",
    isJoker ? "playing-card--joker" : "playing-card--black",
    selected && "playing-card--selected",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? selected : undefined}
      aria-label={isJoker ? "Joker" : card.rank}
    >
      {isJoker ? (
        <>
          <span className="playing-card__index playing-card__index--joker" aria-hidden="true">
            ★
          </span>
          <span className="playing-card__pip" aria-hidden="true">
            ★
          </span>
        </>
      ) : (
        <>
          <span className="playing-card__index" aria-hidden="true">
            <span className="playing-card__rank">{card.rank}</span>
          </span>
          <span className="playing-card__pip" aria-hidden="true">
            {card.rank}
          </span>
        </>
      )}
    </button>
  );
}
