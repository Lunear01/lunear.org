import type { Card } from "../ws/types";
import type { SkinId } from "worker/src/shop/catalog";
import { SkinArt, skinHostClass, useSkinFace } from "../skins/SkinArt";
import { isJoker, isRed, rankLabel, suitGlyph } from "../ws/cards";

interface PlayingCardProps {
  card: Card;
  selected?: boolean;
  small?: boolean;
  /** Omit to render a non-interactive (opponent/history) card. */
  onClick?: () => void;
  /** Owning seat's skin; shared cards stay classic. */
  skin?: SkinId;
  /** Position in a row, for skin variant and stagger. */
  index?: number;
}

/** Rank+suit glyphs in CSS — no card images. Jokers get a distinct gold face. */
export function PlayingCard({ card, selected = false, small = false, onClick, skin, index }: PlayingCardProps) {
  const { ref, faceClass, faceArt } = useSkinFace<HTMLButtonElement>(skin, index);
  const classes = [
    "playing-card",
    small && "playing-card--small",
    isJoker(card) ? "playing-card--joker" : isRed(card) ? "playing-card--red" : "playing-card--black",
    selected && "playing-card--selected",
    faceClass,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      type="button"
      className={classes}
      onClick={onClick}
      disabled={!onClick}
      aria-pressed={onClick ? selected : undefined}
      aria-label={isJoker(card) ? (card.rank === 17 ? "Red joker" : "Black joker") : `${rankLabel(card.rank)} of ${suitGlyph(card)}`}
    >
      {faceArt}
      {isJoker(card) ? (
        <>
          {/* Corner glyph survives the fan overlap; the big centered one is
              purely decorative for a fully-exposed card. */}
          <span className="playing-card__index playing-card__index--joker" aria-hidden="true">
            {card.rank === 17 ? "★" : "☆"}
          </span>
          <span className="playing-card__pip" aria-hidden="true">
            {card.rank === 17 ? "★" : "☆"}
          </span>
        </>
      ) : (
        <>
          <span className="playing-card__index" aria-hidden="true">
            <span className="playing-card__rank">{rankLabel(card.rank)}</span>
            <span className="playing-card__suit">{suitGlyph(card)}</span>
          </span>
          <span className="playing-card__pip" aria-hidden="true">
            {suitGlyph(card)}
          </span>
        </>
      )}
    </button>
  );
}

interface CardBackProps {
  small?: boolean;
  /** Owning seat's skin; shared piles stay classic. */
  skin?: SkinId;
  /** Position in a fan, for skin variant and stagger. */
  index?: number;
}

/** A face-down card back, used for opponents' hands and the pre-bid bottom stack. */
export function CardBack({ small = false, skin = "classic", index = 0 }: CardBackProps) {
  return (
    <div className={`card-back ${small ? "card-back--small" : ""} ${skinHostClass(skin)}`} aria-hidden="true">
      <SkinArt skin={skin} index={index} />
    </div>
  );
}

/** Face-down side of a `.flip` card. */
export function FlipBack({ skin = "classic", index = 0 }: { skin?: SkinId; index?: number }) {
  return (
    <div className={`flip__face flip__face--back ${skinHostClass(skin)}`} aria-hidden="true">
      <SkinArt skin={skin} index={index} />
    </div>
  );
}
