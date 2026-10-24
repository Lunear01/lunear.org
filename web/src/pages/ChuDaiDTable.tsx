import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
// Runtime import of the pure chudaidi engine: hand order (3 high) and the hint.
import { sortHand, suggestPlay } from "chudaidi";
import { CardBack, PlayingCard } from "../components/PlayingCard";
import { useAuth } from "../context/AuthContext";
import type {
  ComboCategory,
  ErrorCode,
  ErrorMessage,
  PlayRecord,
  RedactedView,
  Seat,
  SeatStatus,
} from "../ws/chudaidi-types";
import { useChuDaiDSocket } from "../ws/useChuDaiDSocket";
import "../styles/chudaidi.css";

const CHUDAIDI_LOBBY_PATH = "/lobby/chudaidi";

// Mirrors the registry's minSeats — a hand starts once this many are seated and ready.
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 4;

/** How long the winning play stays on the felt before the settlement panel covers it. */
const FINAL_PLAY_HOLD_MS = 3000;

const FRIENDLY_ERROR: Record<ErrorCode, string> = {
  "wrong-phase": "That action isn't allowed right now.",
  "not-your-turn": "It's not your turn yet.",
  "empty-play": "Select at least one card to play.",
  "invalid-cards": "That's not a legal combination.",
  "cards-not-in-hand": "Those cards aren't in your hand.",
  "wrong-card-count": "Play the same number of cards as the last play.",
  "must-beat-previous": "That play doesn't beat the last one.",
  "must-include-lead-card": "The first play must include the lowest card.",
  "cannot-pass-on-lead": "You have to lead — you can't pass.",
  "bad-message": "Something went wrong sending that action.",
  "table-full": "This table is full.",
  "not-initialized": "This table isn't set up yet.",
  "game-in-progress": "A hand is already in progress.",
  "no-active-hand": "There's no hand in progress right now.",
  "table-aborted": "This game has ended.",
};

const COMBO_NAMES: Record<ComboCategory, string> = {
  single: "Single",
  pair: "Pair",
  triple: "Triple",
  straight: "Straight",
  flush: "Flush",
  fullHouse: "Full house",
  fourOfAKind: "Four of a kind",
  straightFlush: "Straight flush",
};

function friendlyError(err: ErrorMessage): string {
  return FRIENDLY_ERROR[err.code] ?? err.message;
}

function formatDelta(n: number): string {
  return n > 0 ? `+${n.toLocaleString()}` : n.toLocaleString();
}

function formatCredits(n: number): string {
  return n.toLocaleString();
}

function seatLabel(seats: readonly SeatStatus[] | null, seat: Seat): string {
  return seats?.find((s) => s.seat === seat)?.username ?? `Seat ${seat}`;
}

// Chu Dai D cards share doudizhu's id/rank/suit shape minus jokers, so
// PlayingCard takes them as-is; order comes from the engine (4 low, 3 high).
const sortCards = sortHand;

export default function ChuDaiDTable() {
  const { tableId = "" } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { status, seats, view, error, settled, aborted, send, dismissError } = useChuDaiDSocket(tableId);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hintMessage, setHintMessage] = useState<string | null>(null);

  const mySeat = useMemo<Seat | null>(() => {
    if (view) return view.viewer;
    if (!seats || !user) return null;
    return seats.find((s) => s.userId === user.id)?.seat ?? null;
  }, [view, seats, user]);

  // Reset selection only when the hand's contents change, not on every broadcast.
  const handKey = view?.phase === "playing" ? view.hand.map((c) => c.id).join(",") : "";
  useEffect(() => {
    setSelected(new Set());
  }, [handKey]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(dismissError, 4000);
    return () => clearTimeout(t);
  }, [error, dismissError]);

  useEffect(() => {
    if (settled?.newBalance !== undefined) void refresh();
  }, [settled, refresh]);

  useEffect(() => {
    if (!hintMessage) return;
    const t = setTimeout(() => setHintMessage(null), 2500);
    return () => clearTimeout(t);
  }, [hintMessage]);

  const handleHint = () => {
    if (view?.phase !== "playing") return;
    const suggestion = suggestPlay(view.hand, view.lastPlay ? view.lastPlay.combo : null, view.leadCardId);
    if (suggestion) {
      setSelected(new Set(suggestion.map((c) => c.id)));
    } else {
      setSelected(new Set());
      setHintMessage("No playable hand — pass");
    }
  };

  // The settlement panel waits so the winning play is seen before it's covered.
  const [settledVisible, setSettledVisible] = useState(false);
  useEffect(() => {
    setSettledVisible(false);
    if (!settled) return;
    const t = setTimeout(() => setSettledVisible(true), FINAL_PLAY_HOLD_MS);
    return () => clearTimeout(t);
  }, [settled]);

  const toggleCard = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const mySeatRow = mySeat !== null ? seats?.find((s) => s.seat === mySeat) : undefined;
  const amReady = mySeatRow?.ready ?? false;
  const canReadyUp =
    !aborted && seats !== null && seats.length >= MIN_PLAYERS && (view === null || view.phase === "finished");

  // False for a player who took a free seat mid-hand — they wait for the next one.
  const myInGame = view !== null && mySeat !== null && view.activeSeats.includes(mySeat);
  const myTurn = view?.phase === "playing" && mySeat === view.currentTurn;
  const finishedView = view?.phase === "finished" ? view : null;
  const viewerWon = finishedView !== null && finishedView.winner === finishedView.viewer;

  const handleExitToLobby = () => navigate(CHUDAIDI_LOBBY_PATH);

  // Mid-hand leave tells the server first so the hand aborts for everyone at once.
  const handleLeaveTable = () => {
    send({ type: "leave" });
    navigate("/");
  };

  // Opponents read left-to-right from the seat after mine.
  const orderedOpponents = useMemo<readonly Seat[]>(() => {
    const base = mySeat ?? 0;
    return [1, 2, 3].map((offset) => ((base + offset) % MAX_PLAYERS) as Seat);
  }, [mySeat]);

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

      <div className="table-felt">
        <div className="table-opponents-row cd-opponents">
          {orderedOpponents.map((seat) => (
            <ChuDaiDOpponentSeat key={seat} seat={seat} seats={seats} view={view} />
          ))}
        </div>

        <div className="table-center card">
          <ChuDaiDCenter seats={seats} view={view} />
        </div>

        {view?.phase === "playing" && (
          <>
            {!myInGame && (
              <div className="cd-self-status">
                <span>Hand in progress — you join the next one</span>
              </div>
            )}
            <div className="table-hand">
              {sortCards(view.hand).map((card) => (
                <PlayingCard
                  key={card.id}
                  card={card}
                  selected={selected.has(card.id)}
                  // Selectable off-turn so a play can be lined up while waiting.
                  onClick={() => toggleCard(card.id)}
                />
              ))}
            </div>
          </>
        )}

        {finishedView && mySeat !== null && finishedView.hands[mySeat].length > 0 && (
          <div className="table-hand">
            {sortCards(finishedView.hands[mySeat]).map((card) => (
              <PlayingCard key={card.id} card={card} />
            ))}
          </div>
        )}

        {hintMessage && (
          <p className="hint-toast" role="status">
            {hintMessage}
          </p>
        )}

        <div className="table-actions">
          {myTurn && (
            <>
              <button
                type="button"
                className="button"
                disabled={view.lastPlay === null}
                onClick={() => send({ type: "pass" })}
              >
                Pass
              </button>
              <button type="button" className="button" onClick={handleHint}>
                Hint
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={selected.size === 0}
                onClick={() => send({ type: "play", cardIds: [...selected] })}
              >
                Play{selected.size > 0 ? ` (${selected.size})` : ""}
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

      {settled && !aborted && settledVisible && (
        <div className="settled-overlay">
          <div className="settled-card card">
            <h2 className={`modal__title settled-card__winner ${viewerWon ? "settled-card__winner--gold" : ""}`}>
              {finishedView ? `${seatLabel(seats, finishedView.winner)} goes out` : "Hand settled"}
            </h2>
            <ul>
              {(finishedView?.activeSeats ?? ([0, 1, 2, 3] as const)).map((seat) => (
                <li key={seat}>
                  {seatLabel(seats, seat)}
                  {finishedView && seat !== finishedView.winner && (
                    <span className="cd-settled__left"> · {finishedView.hands[seat].length} left</span>
                  )}
                  : {formatDelta(settled.deltas[seat])}
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

function ChuDaiDOpponentSeat({
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
  const count =
    view === null || !inGame ? null : view.phase === "playing" ? view.handCounts[seat] : view.hands[seat].length;
  const isTurn = view?.phase === "playing" && view.currentTurn === seat;
  const passed =
    view?.phase === "playing" &&
    view.lastPlay !== null &&
    view.lastPlay.seat !== seat &&
    view.history.length > 0 &&
    lastActionWasPass(view.history, seat, view.lastPlay.seat);

  // An empty seat renders as a quiet placeholder so the row keeps its shape.
  if (!row) {
    return (
      <div className="table-opponent cd-opponent cd-opponent--empty">
        <div className="table-opponent__info">
          <span className="table-opponent__name">Open seat</span>
        </div>
      </div>
    );
  }

  return (
    <div className={`table-opponent cd-opponent ${isTurn ? "cd-opponent--turn" : ""}`}>
      <div className="table-opponent__cards">
        {count !== null && count > 0 && view?.phase === "playing"
          ? Array.from({ length: count }).map((_, i) => <CardBack key={i} small skin={row?.cardSkin} index={i} />)
          : null}
        {view?.phase === "finished" && inGame && count !== null && count > 0 && (
          <div className="cd-revealed">
            {sortCards(view.hands[seat]).map((c) => (
              <PlayingCard key={c.id} card={c} small />
            ))}
          </div>
        )}
      </div>
      <div className="table-opponent__info">
        <span
          className={`status-dot ${row.connected ? "status-dot--online" : "status-dot--offline"}`}
          aria-label={row.connected ? "connected" : "disconnected"}
        />
        <span className="table-opponent__name">{row.username}</span>
        <span className={`seat-credits ${row.credits < 0 ? "seat-credits--negative" : ""}`}>
          {formatCredits(row.credits)}
        </span>
        {count !== null && <span className="table-opponent__count">({count})</span>}
        {isTurn && <span title="Current turn">🎯</span>}
        {passed && <span className="cd-passed">passed</span>}
        {row.ready && !view && <span className="ready-badge">Ready</span>}
        {view !== null && !inGame && <span className="table-opponent__count">next hand</span>}
      </div>
    </div>
  );
}

/** True if `seat`'s most recent action since the current trick's play was a pass. */
function lastActionWasPass(history: readonly PlayRecord[], seat: Seat, lastPlaySeat: Seat): boolean {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i];
    if (entry.seat === lastPlaySeat && entry.combo !== null) return false;
    if (entry.seat === seat) return entry.combo === null;
  }
  return false;
}

function ChuDaiDCenter({ seats, view }: { seats: readonly SeatStatus[] | null; view: RedactedView | null }) {
  if (!view) {
    const filled = seats?.length ?? 0;
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

  if (view.phase === "playing") {
    return (
      <div>
        {view.lastPlay ? (
          <>
            <div className="table-cardrow table-cardrow--lastplay">
              {sortCards(view.lastPlay.combo.cards).map((c) => (
                <PlayingCard key={c.id} card={c} />
              ))}
            </div>
            <p className="table-center__hint">
              {seatLabel(seats, view.lastPlay.seat)} · {COMBO_NAMES[view.lastPlay.combo.category]}
            </p>
          </>
        ) : view.leadCardId ? (
          <p className="table-center__hint">First play must include the {leadCardName(view.leadCardId)}</p>
        ) : (
          <p className="table-center__hint">Free lead — play anything</p>
        )}
        <p className="table-center__turn">
          {view.currentTurn === view.viewer ? "Your turn" : `Waiting on ${seatLabel(seats, view.currentTurn)}`}
        </p>
      </div>
    );
  }

  const finalPlay = [...view.history].reverse().find((h) => h.combo !== null);
  return (
    <div>
      {finalPlay?.combo && (
        <div className="table-cardrow table-cardrow--lastplay">
          {sortCards(finalPlay.combo.cards).map((c) => (
            <PlayingCard key={c.id} card={c} />
          ))}
        </div>
      )}
      <p className="table-center__turn">{seatLabel(seats, view.winner)} goes out</p>
    </div>
  );
}

/** "3D" -> "3♦", for the first-play hint. */
function leadCardName(id: string): string {
  const suit = id.slice(-1);
  const rank = id.slice(0, -1);
  const glyph = { S: "♠", H: "♥", D: "♦", C: "♣" }[suit] ?? suit;
  return `${rank}${glyph}`;
}
