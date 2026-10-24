import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { UnoCard, UnoCardBack, cardLabel } from "../components/UnoCard";
import { useAuth } from "../context/AuthContext";
import { SeatAura } from "../skins/effects/SeatAura";
import { SkinBurst } from "../skins/effects/SkinBurst";
import { SkinMoment } from "../skins/effects/SkinMoment";
import { useFreshKey } from "../skins/effects/useFreshKey";
import { seatSkin } from "../skins/SkinArt";
import type { SkinId } from "worker/src/shop/catalog";
import type {
  Card,
  Color,
  ErrorCode,
  ErrorMessage,
  GameEvent,
  RedactedPlayingView,
  RedactedView,
  Seat,
  SeatStatus,
} from "../ws/uno-types";
import { useUnoSocket } from "../ws/useUnoSocket";
import "../styles/uno.css";

const UNO_LOBBY_PATH = "/lobby/uno";
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;
const COLORS: readonly Color[] = ["red", "yellow", "green", "blue"];
const COLOR_NAME: Record<Color, string> = { red: "Red", yellow: "Yellow", green: "Green", blue: "Blue" };

/** How long the winning play stays on the felt before the settlement panel covers it. */
const FINAL_PLAY_HOLD_MS = 2500;

const FRIENDLY_ERROR: Record<ErrorCode, string> = {
  "wrong-phase": "That action isn't allowed right now.",
  "not-your-turn": "It's not your turn yet.",
  "cards-not-in-hand": "That card isn't in your hand.",
  "card-not-playable": "That card doesn't match the colour or the top card.",
  "color-required": "Pick a colour for the wild.",
  "invalid-color": "That's not a colour.",
  "wild-draw-four-not-allowed": "You can't play Wild Draw Four while holding the current colour.",
  "must-play-drawn-card": "After drawing you can only play the card you drew, or pass.",
  "already-drew": "You already drew this turn — play it or pass.",
  "cannot-pass": "You can only pass after drawing a card.",
  "cannot-call-uno": "You can only call UNO while holding exactly one card.",
  "nothing-to-catch": "Nobody is open to a catch right now.",
  "bad-message": "Something went wrong sending that action.",
  "table-full": "This table is full.",
  "not-initialized": "This table isn't set up yet.",
  "game-in-progress": "A hand is already in progress.",
  "no-active-hand": "There's no hand in progress right now.",
  "table-aborted": "This game has ended.",
};

function friendlyError(err: ErrorMessage): string {
  return FRIENDLY_ERROR[err.code] ?? err.message;
}

function formatDelta(n: number): string {
  return n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
}

function seatLabel(seats: readonly SeatStatus[] | null, seat: Seat, viewer: Seat | null): string {
  if (seat === viewer) return "You";
  return seats?.find((s) => s.seat === seat)?.username ?? `Seat ${seat}`;
}

/** Client-side mirror of the engine's play rule, used only to dim unplayable cards. */
function isPlayable(card: Card, hand: readonly Card[], top: Card, currentColor: Color): boolean {
  const wild = card.color === null;
  const topWild = top.color === null;
  const matches =
    wild ||
    card.color === currentColor ||
    (!topWild && card.kind === top.kind && (card.kind !== "number" || card.value === top.value));
  if (!matches) return false;
  if (card.kind === "wild4") return !hand.some((c) => c.id !== card.id && c.color === currentColor);
  return true;
}

const COLOR_ORDER: Record<string, number> = { red: 0, yellow: 1, green: 2, blue: 3 };
const KIND_ORDER: Record<string, number> = { number: 0, skip: 1, reverse: 2, draw2: 3, wild: 4, wild4: 5 };

function sortForHand(cards: readonly Card[]): Card[] {
  return [...cards].sort((a, b) => {
    const ca = a.color === null ? 4 : COLOR_ORDER[a.color];
    const cb = b.color === null ? 4 : COLOR_ORDER[b.color];
    if (ca !== cb) return ca - cb;
    if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
    return (a.value ?? 0) - (b.value ?? 0) || a.id.localeCompare(b.id);
  });
}

function describeEvents(events: readonly GameEvent[], seats: readonly SeatStatus[] | null, viewer: Seat | null): string {
  const parts: string[] = [];
  for (const e of events) {
    switch (e.type) {
      case "played": {
        const who = seatLabel(seats, e.seat, viewer);
        const wild = e.card.color === null;
        parts.push(`${who} played ${cardLabel(e.card)}${wild ? ` and chose ${COLOR_NAME[e.color].toLowerCase()}` : ""}.`);
        break;
      }
      case "drew":
        parts.push(
          e.count === 0
            ? `${seatLabel(seats, e.seat, viewer)} had nothing to draw.`
            : `${seatLabel(seats, e.seat, viewer)} drew ${e.count} card${e.count === 1 ? "" : "s"}.`,
        );
        break;
      case "passed":
        parts.push(`${seatLabel(seats, e.seat, viewer)} passed.`);
        break;
      case "skipped":
        parts.push(`${seatLabel(seats, e.seat, viewer)} is skipped.`);
        break;
      case "reversed":
        parts.push("Direction reversed.");
        break;
      case "reshuffled":
        parts.push("Discards reshuffled into the draw pile.");
        break;
      case "called-uno":
        parts.push(`${seatLabel(seats, e.seat, viewer)} called UNO!`);
        break;
      case "caught":
        parts.push(`${seatLabel(seats, e.by, viewer)} caught ${seatLabel(seats, e.seat, viewer)} without a UNO call.`);
        break;
    }
  }
  return parts.join(" ");
}

export default function UnoTable() {
  const { tableId = "" } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { status, seats, view, error, settled, aborted, send, dismissError } = useUnoSocket(tableId);

  /** A wild waiting for its colour. */
  const [pendingWild, setPendingWild] = useState<Card | null>(null);
  /** "UNO!" armed: the next play goes out with the call attached. */
  const [armUno, setArmUno] = useState(false);

  const mySeat = useMemo<Seat | null>(() => {
    if (view) return view.viewer;
    if (!seats || !user) return null;
    return seats.find((s) => s.userId === user.id)?.seat ?? null;
  }, [view, seats, user]);

  // Auto-dismiss the error toast.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(dismissError, 4000);
    return () => clearTimeout(t);
  }, [error, dismissError]);

  // Settlement includes our fresh balance — push it into the header immediately.
  useEffect(() => {
    if (settled?.newBalance !== undefined) void refresh();
  }, [settled, refresh]);

  // The settlement panel waits so the final play is seen before it's covered.
  const [settledVisible, setSettledVisible] = useState(false);
  useEffect(() => {
    setSettledVisible(false);
    if (!settled) return;
    const t = setTimeout(() => setSettledVisible(true), FINAL_PLAY_HOLD_MS);
    return () => clearTimeout(t);
  }, [settled]);

  // A change in the hand drops any half-finished wild choice and the armed call.
  const handKey = view && "hand" in view ? view.hand.map((c) => c.id).join(",") : "";
  useEffect(() => {
    setPendingWild(null);
    setArmUno(false);
  }, [handKey]);

  const playingView: RedactedPlayingView | null = view?.phase === "playing" ? view : null;
  const finishedView = view?.phase === "finished" ? view : null;
  const myTurn = playingView !== null && mySeat !== null && playingView.currentTurn === mySeat;
  const myInGame = view !== null && mySeat !== null && view.activeSeats.includes(mySeat);

  const mySeatRow = mySeat !== null ? seats?.find((s) => s.seat === mySeat) : undefined;
  const amReady = mySeatRow?.ready ?? false;
  const seatedCount = seats?.filter((s) => s.userId !== null).length ?? 0;
  const canReadyUp =
    !aborted && seats !== null && seatedCount >= MIN_PLAYERS && (view === null || view.phase === "finished");

  const unoFlag = armUno ? { uno: true } : {};

  const handleCardTap = (card: Card) => {
    if (!playingView || !myTurn) return;
    if (card.color === null) {
      setPendingWild(card);
      return;
    }
    send({ type: "play", cardId: card.id, ...unoFlag });
  };

  const handlePickColor = (color: Color) => {
    if (!pendingWild) return;
    send({ type: "play", cardId: pendingWild.id, color, ...unoFlag });
    setPendingWild(null);
  };

  // The arm toggle only matters when the next play leaves exactly one card.
  const canArmUno = myTurn && playingView !== null && playingView.hand.length === 2;
  const iCalled = playingView !== null && mySeat !== null && playingView.unoCalled.includes(mySeat);
  const canCallUno = playingView !== null && myInGame && playingView.hand.length === 1 && !iCalled;
  const catchable =
    playingView !== null && myInGame && playingView.unoVulnerable !== null && playingView.unoVulnerable !== mySeat
      ? playingView.unoVulnerable
      : null;

  const handleExitToLobby = () => navigate(UNO_LOBBY_PATH);

  // Mid-hand "Leave table" tells the server first so an active hand aborts
  // for everyone instead of waiting out the 30s disconnect grace.
  const handleLeaveTable = () => {
    send({ type: "leave" });
    navigate("/");
  };

  // Opponents in turn order starting from the seat after mine.
  const orderedOpponents = useMemo<readonly Seat[]>(() => {
    const base = mySeat ?? 0;
    const all = [1, 2, 3, 4, 5].map((offset) => ((base + offset) % MAX_PLAYERS) as Seat);
    if (!seats) return all;
    return all.filter((seat) => {
      const row = seats.find((s) => s.seat === seat);
      return row?.userId !== null && row !== undefined;
    });
  }, [mySeat, seats]);

  const sortedHand = useMemo(() => (view && "hand" in view ? sortForHand(view.hand) : []), [view]);
  const mySkin = mySeat !== null ? seatSkin(seats, mySeat) : "classic";

  return (
    <div className="table-page">
      <div className="table-topbar">
        <button type="button" className="button button--ghost button--small" onClick={handleLeaveTable}>
          Leave table
        </button>
        {status !== "open" && (
          <span className="table-connection-banner">
            {status === "connecting" && "Connecting…"}
            {status === "reconnecting" && "Reconnecting…"}
            {status === "closed" && "Disconnected"}
          </span>
        )}
      </div>

      {error && (
        <div className="table-toast" role="alert">
          {friendlyError(error)}
        </div>
      )}

      {view && <UnoMoments seats={seats} view={view} mySeat={mySeat} />}

      <div className="table-felt">
        <div className="uno-opponents">
          {orderedOpponents.length === 0 && !view && (
            <p className="table-center__hint">Waiting for an opponent…</p>
          )}
          {orderedOpponents.map((seat) => (
            <UnoOpponentSeat key={seat} seat={seat} seats={seats} view={view} />
          ))}
        </div>

        <div className="table-center card">
          <UnoCenter seats={seats} view={view} mySeat={mySeat} onDraw={() => send({ type: "draw" })} />
        </div>

        {view && "hand" in view && (
          <>
            {playingView && !myInGame && (
              <div className="uno-self">
                <span>Hand in progress — you join the next one</span>
              </div>
            )}
            {playingView && myInGame && (
              <div className="uno-self">
                <SeatAura skin={mySkin} active={myTurn} />
                {myTurn ? (
                  <span className="table-center__turn">
                    {playingView.pendingDraw ? "Play the card you drew, or pass" : "Your turn — tap a card or draw"}
                  </span>
                ) : (
                  <span>
                    {sortedHand.length} card{sortedHand.length === 1 ? "" : "s"}
                    {iCalled && <span className="uno-badge"> UNO!</span>}
                  </span>
                )}
              </div>
            )}
            <div className="uno-hand">
              {sortedHand.map((card, i) => {
                const playable =
                  playingView !== null &&
                  (playingView.pendingDraw === null
                    ? isPlayable(card, playingView.hand, playingView.topCard, playingView.currentColor)
                    : card.id === playingView.pendingDraw);
                return (
                  <UnoCard
                    key={card.id}
                    card={card}
                    skin={mySkin}
                    index={i}
                    playable={!myTurn || playable}
                    highlighted={playingView !== null && card.id === playingView.pendingDraw}
                    onClick={myTurn ? () => handleCardTap(card) : undefined}
                  />
                );
              })}
            </div>
          </>
        )}

        <div className="table-actions">
          {canArmUno && (
            <button
              type="button"
              className={`button uno-arm ${armUno ? "uno-arm--on" : ""}`}
              aria-pressed={armUno}
              onClick={() => setArmUno((v) => !v)}
            >
              UNO!
            </button>
          )}
          {canCallUno && (
            <button type="button" className="button button--primary uno-arm" onClick={() => send({ type: "callUno" })}>
              Call UNO
            </button>
          )}
          {catchable !== null && (
            <button
              type="button"
              className="button button--primary uno-catch"
              onClick={() => send({ type: "catchUno", target: catchable })}
            >
              Catch {seatLabel(seats, catchable, mySeat)}
            </button>
          )}
          {playingView && myTurn && (
            <>
              <button
                type="button"
                className="button"
                disabled={playingView.pendingDraw !== null}
                onClick={() => send({ type: "draw" })}
              >
                Draw
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={playingView.pendingDraw === null}
                onClick={() => send({ type: "pass" })}
              >
                Pass
              </button>
            </>
          )}

          {canReadyUp && !settled && (
            <button
              type="button"
              className="button button--primary"
              disabled={amReady}
              onClick={() => send({ type: "ready" })}
            >
              {amReady ? "Waiting for others…" : view?.phase === "finished" ? "Ready for next hand" : "Ready"}
            </button>
          )}
        </div>
      </div>

      {pendingWild && (
        <div className="uno-picker" role="dialog" aria-modal="true" aria-label="Choose a colour">
          <div className="uno-picker__card card">
            <p className="modal__title">Choose a colour</p>
            <div className="uno-picker__grid">
              {COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  className={`uno-picker__swatch uno-picker__swatch--${color}`}
                  onClick={() => handlePickColor(color)}
                >
                  {COLOR_NAME[color]}
                </button>
              ))}
            </div>
            <button type="button" className="button button--small" onClick={() => setPendingWild(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {settled && !aborted && finishedView && settledVisible && (
        <div className="settled-overlay">
          <div className="settled-card card">
            <h2
              className={`modal__title settled-card__winner ${finishedView.winner === mySeat ? "settled-card__winner--gold" : ""}`}
            >
              {finishedView.winner === mySeat ? "You win!" : `${seatLabel(seats, finishedView.winner, mySeat)} wins`}
            </h2>
            <ul className="uno-results">
              {finishedView.activeSeats.map((seat) => (
                <li key={seat} className="uno-results__row">
                  <span>
                    {seatLabel(seats, seat, mySeat)}
                    {seat !== finishedView.winner && ` · ${finishedView.points[seat]} pts`}
                  </span>
                  <span className="uno-results__cards">
                    {sortForHand(finishedView.hands[seat]).map((c) => (
                      <UnoCard key={c.id} card={c} small />
                    ))}
                  </span>
                  <span>{formatDelta(settled.deltas[seat])}</span>
                </li>
              ))}
            </ul>
            {settled.newBalance !== undefined && (
              <p className="modal__hint">Your new balance: {settled.newBalance.toLocaleString()} credits</p>
            )}
            <div className="settled-card__actions">
              <button
                type="button"
                className="button button--primary"
                disabled={amReady}
                onClick={() => send({ type: "ready" })}
              >
                {amReady ? "Waiting for others…" : "Ready for next hand"}
              </button>
              <button type="button" className="button" onClick={handleExitToLobby}>
                Exit to lobby
              </button>
            </div>
          </div>
        </div>
      )}

      {aborted && (
        <div className="settled-overlay">
          <div className="settled-card card">
            <h2 className="modal__title settled-card__winner">Game ended</h2>
            <p className="modal__hint">{aborted.leaver.username} left the game</p>
            <div className="settled-card__actions">
              <button type="button" className="button button--primary" onClick={handleExitToLobby}>
                Exit to lobby
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function UnoOpponentSeat({
  seat,
  seats,
  view,
}: {
  seat: Seat;
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
}) {
  const row = seats?.find((s) => s.seat === seat);
  const inGame = view === null || view.activeSeats.includes(seat);
  const count = view && inGame ? (view.phase === "playing" ? view.handCounts[seat] : view.hands[seat].length) : null;
  const isTurn = view?.phase === "playing" && view.currentTurn === seat;
  const isWinner = view?.phase === "finished" && view.winner === seat;

  return (
    <div className={`uno-opponent ${isTurn ? "uno-opponent--turn" : ""}`}>
      {row && <SeatAura skin={row.cardSkin} active={isTurn} />}
      <div className="uno-opponent__cards">
        {count !== null && Array.from({ length: Math.min(count, 12) }).map((_, i) => <UnoCardBack key={i} small skin={row?.cardSkin} index={i} />)}
      </div>
      <div className="uno-opponent__info">
        <span
          className={`status-dot ${row?.connected ? "status-dot--online" : "status-dot--offline"}`}
          aria-label={row?.connected ? "connected" : "disconnected"}
        />
        <span className="uno-opponent__name">{row?.username ?? "Waiting…"}</span>
        {row?.userId !== null && row !== undefined && (
          <span className={`seat-credits ${row.credits < 0 ? "seat-credits--negative" : ""}`}>
            {row.credits.toLocaleString()}
          </span>
        )}
        {count !== null && <span className="table-opponent__count">({count})</span>}
        {view?.phase === "playing" && view.unoCalled.includes(seat) && <span className="uno-badge">UNO!</span>}
        {view?.phase === "playing" && view.unoVulnerable === seat && (
          <span className="uno-open" title="Didn't call UNO">
            open!
          </span>
        )}
        {isTurn && <span title="Current turn">🎯</span>}
        {isWinner && <span title="Winner">🏆</span>}
        {row?.ready && !view && <span className="ready-badge">Ready</span>}
        {view !== null && !inGame && row?.userId != null && <span className="table-opponent__count">next hand</span>}
      </div>
    </div>
  );
}

function UnoCenter({
  seats,
  view,
  mySeat,
  onDraw,
}: {
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
  mySeat: Seat | null;
  onDraw: () => void;
}) {
  if (!view) {
    const filled = seats?.filter((s) => s.userId !== null).length ?? 0;
    if (filled < MIN_PLAYERS) {
      return (
        <p className="table-center__hint">
          Waiting for players ({filled}/{MAX_PLAYERS} seated, {MIN_PLAYERS} needed)…
        </p>
      );
    }
    return (
      <p className="table-center__hint">
        {filled}/{MAX_PLAYERS} seated — everyone ready starts the hand.
      </p>
    );
  }

  const top = view.phase === "playing" ? view.topCard : view.discardPile[view.discardPile.length - 1];
  const myTurn = view.phase === "playing" && view.currentTurn === mySeat;
  const canDraw = myTurn && view.phase === "playing" && view.pendingDraw === null;

  return (
    <div className="uno-center">
      <div className="uno-piles">
        <div className="uno-pile uno-pile--draw">
          <div className="uno-pile__stack">
            {canDraw ? (
              <button type="button" className="uno-card uno-card--back" onClick={onDraw} aria-label="Draw a card">
                <span className="uno-card__oval uno-card__oval--back" aria-hidden="true">
                  <span className="uno-card__center uno-card__center--back">UNO</span>
                </span>
              </button>
            ) : (
              <UnoCardBack />
            )}
          </div>
          <span>{view.phase === "playing" ? `Draw · ${view.drawPileCount}` : "Draw"}</span>
        </div>
        <div className="uno-pile uno-pile--discard">
          <UnoDiscard top={top} view={view} skin={seatSkin(seats, view.lastPlayedBy ?? -1)} />
          <span>{view.lastPlayedBy === null ? "Discard" : seatLabel(seats, view.lastPlayedBy, mySeat)}</span>
        </div>
      </div>

      <div className="uno-color">
        <span className={`uno-color__swatch uno-color__swatch--${view.currentColor}`} aria-hidden="true" />
        <span>{COLOR_NAME[view.currentColor]}</span>
        {view.phase === "playing" && (
          <span className="uno-direction" title={view.direction === 1 ? "Clockwise" : "Counter-clockwise"}>
            {view.direction === 1 ? "↻" : "↺"}
          </span>
        )}
      </div>

      <p className="uno-events">{describeEvents(view.lastEvents, seats, mySeat)}</p>

      {view.phase === "playing" && (
        <p className="table-center__turn">
          {myTurn
            ? "Your turn"
            : `Waiting on ${seatLabel(seats, view.currentTurn, mySeat)}${view.awaitingDrawDecision ? " (deciding on a drawn card)" : ""}`}
        </p>
      )}
      {view.phase === "finished" && (
        <p className="table-center__turn">{seatLabel(seats, view.winner, mySeat)} goes out!</p>
      )}
    </div>
  );
}

/** Discard top stays classic; the burst wears the playing seat's skin. */
function UnoDiscard({ top, view, skin }: { top: Card; view: RedactedView; skin: SkinId }) {
  const burstKey = useFreshKey(view.lastPlayedBy === null ? null : top.id);
  return (
    <div className="uno-pile__stack">
      <UnoCard card={top} />
      <SkinBurst skin={skin} burstKey={burstKey} />
    </div>
  );
}

interface Moment {
  key: string;
  skin: SkinId;
  label: string;
}

/** UNO calls and hand wins, once each. Mount with the view so a page load doesn't replay them. */
function UnoMoments({
  seats,
  view,
  mySeat,
}: {
  seats: readonly SeatStatus[] | null;
  view: RedactedView;
  mySeat: Seat | null;
}) {
  let moment: Moment | null = null;
  if (view.phase === "finished") {
    const { winner, discardPile } = view;
    moment = {
      key: `win:${winner}:${discardPile.length}:${discardPile[discardPile.length - 1].id}`,
      skin: seatSkin(seats, winner),
      label: winner === mySeat ? "You win!" : `${seatLabel(seats, winner, mySeat)} wins`,
    };
  } else {
    const call = view.lastEvents.find((e): e is Extract<GameEvent, { type: "called-uno" }> => e.type === "called-uno");
    if (call) {
      moment = {
        key: `uno:${call.seat}:${view.topCard.id}:${view.drawPileCount}`,
        skin: seatSkin(seats, call.seat),
        label: "UNO!",
      };
    }
  }
  const fresh = useFreshKey(moment?.key ?? null);
  return <SkinMoment skin={moment?.skin ?? "classic"} momentKey={fresh} label={moment?.label ?? ""} />;
}
