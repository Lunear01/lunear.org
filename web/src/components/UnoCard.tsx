import type { SkinId } from "worker/src/shop/catalog";
import { SkinArt, skinHostClass } from "../skins/SkinArt";
import type { Card, Color } from "../ws/uno-types";

interface UnoCardProps {
  card: Card;
  /** Dimmed and non-interactive when false and onClick is given. */
  playable?: boolean;
  highlighted?: boolean;
  small?: boolean;
  /** Omit to render a non-interactive (table/opponent) card. */
  onClick?: () => void;
}

const COLOR_NAME: Record<Color, string> = { red: "Red", yellow: "Yellow", green: "Green", blue: "Blue" };

/** Short glyph for the corner pips and the centre. */
export function cardGlyph(card: Card): string {
  switch (card.kind) {
    case "number":
      return String(card.value);
    case "skip":
      return "⊘";
    case "reverse":
      return "⇄";
    case "draw2":
      return "+2";
    case "wild":
      return "W";
    case "wild4":
      return "+4";
  }
}

export function cardLabel(card: Card): string {
  const kind =
    card.kind === "number"
      ? String(card.value)
      : card.kind === "skip"
        ? "Skip"
        : card.kind === "reverse"
          ? "Reverse"
          : card.kind === "draw2"
            ? "Draw Two"
            : card.kind === "wild"
              ? "Wild"
              : "Wild Draw Four";
  return card.color ? `${COLOR_NAME[card.color]} ${kind}` : kind;
}

/**
 * CSS-drawn UNO face: colour field, white oval, big centre glyph, small
 * corner glyphs. Wilds show a four-colour quadrant inside the oval.
 */
export function UnoCard({ card, playable = true, highlighted = false, small = false, onClick }: UnoCardProps) {
  const wild = card.color === null;
  const classes = [
    "uno-card",
    small && "uno-card--small",
    wild ? "uno-card--wild" : `uno-card--${card.color}`,
    onClick && !playable && "uno-card--dim",
    highlighted && "uno-card--highlighted",
  ]
    .filter(Boolean)
    .join(" ");
  const glyph = cardGlyph(card);
  const isWildGlyph = card.kind === "wild";

  return (
    <button
      type="button"
      className={classes}
      onClick={onClick}
      disabled={!onClick || !playable}
      aria-label={cardLabel(card)}
    >
      <span className="uno-card__corner uno-card__corner--top" aria-hidden="true">
        {glyph}
      </span>
      <span className="uno-card__oval" aria-hidden="true">
        {wild && (
          <span className="uno-card__quad">
            <span className="uno-card__quad-cell uno-card__quad-cell--red" />
            <span className="uno-card__quad-cell uno-card__quad-cell--yellow" />
            <span className="uno-card__quad-cell uno-card__quad-cell--green" />
            <span className="uno-card__quad-cell uno-card__quad-cell--blue" />
          </span>
        )}
        {!isWildGlyph && <span className="uno-card__center">{glyph}</span>}
      </span>
      <span className="uno-card__corner uno-card__corner--bottom" aria-hidden="true">
        {glyph}
      </span>
    </button>
  );
}

/** A face-down UNO card back: black field with a red oval and the word, or the owning seat's skin. */
export function UnoCardBack({ small = false, skin = "classic", index = 0 }: { small?: boolean; skin?: SkinId; index?: number }) {
  return (
    <div className={`uno-card uno-card--back ${small ? "uno-card--small" : ""} ${skinHostClass(skin)}`} aria-hidden="true">
      {skin === "classic" ? (
        <span className="uno-card__oval uno-card__oval--back">
          <span className="uno-card__center uno-card__center--back">UNO</span>
        </span>
      ) : (
        <SkinArt skin={skin} index={index} />
      )}
    </div>
  );
}
