import type { Card } from "../ws/types";
import { isJoker, isRed, rankLabel, suitGlyph } from "../ws/cards";

interface PlayingCardProps {
  card: Card;
  selected?: boolean;
  small?: boolean;
  /** Omit to render a non-interactive (opponent/history) card. */
  onClick?: () => void;
}

/** Rank+suit glyphs in CSS — no card images. Jokers get a distinct gold face. */
export function PlayingCard({ card, selected = false, small = false, onClick }: PlayingCardProps) {
  const classes = [
    "playing-card",
    small && "playing-card--small",
    isJoker(card) ? "playing-card--joker" : isRed(card) ? "playing-card--red" : "playing-card--black",
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
      aria-label={isJoker(card) ? (card.rank === 17 ? "Red joker" : "Black joker") : `${rankLabel(card.rank)} of ${suitGlyph(card)}`}
    >
      {isJoker(card) ? (
        <span className="playing-card__joker">{card.rank === 17 ? "★" : "☆"}</span>
      ) : (
        <>
          <span className="playing-card__rank">{rankLabel(card.rank)}</span>
          <span className="playing-card__suit">{suitGlyph(card)}</span>
        </>
      )}
    </button>
  );
}

/** A face-down card back, used for opponents' hands and the pre-bid bottom stack. */
export function CardBack({ small = false }: { small?: boolean }) {
  return <div className={`card-back ${small ? "card-back--small" : ""}`} aria-hidden="true" />;
}
