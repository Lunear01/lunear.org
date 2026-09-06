import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
// Runtime import of the pure, dependency-free doudizhu engine — this is the
// one place web/ pulls game logic (not just types) into the client bundle,
// so a hint can be computed locally without a server round-trip.
import { suggestPlay } from "doudizhu";
import { CardBack, PlayingCard } from "../components/PlayingCard";
import { useAuth } from "../context/AuthContext";
import { sortForHand } from "../ws/cards";
import type { ClientMessage, ErrorCode, ErrorMessage, Seat, SeatStatus } from "../ws/types";
import { useGameSocket } from "../ws/useGameSocket";

// This table page is doudizhu-specific (see the `suggestPlay` import above),
// so the lobby it returns to on exit is hardcoded rather than derived.
const DOUDIZHU_LOBBY_PATH = "/lobby/doudizhu";

const SEATS: readonly Seat[] = [0, 1, 2];

const FRIENDLY_ERROR: Record<ErrorCode, string> = {
  "wrong-phase": "That action isn't allowed right now.",
  "not-your-turn": "It's not your turn yet.",
  "invalid-bid": "That's not a valid bid.",
  "bid-too-low": "You have to bid higher than the current bid.",
  "invalid-cards": "That's not a legal combination.",
  "cards-not-in-hand": "Those cards aren't in your hand.",
  "must-beat-previous": "That play doesn't beat the last one.",
  "cannot-pass-on-lead": "You have to lead — you can't pass.",
  "empty-play": "Select at least one card to play.",
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

function seatLabel(seats: readonly SeatStatus[] | null, seat: Seat): string {
  return seats?.find((s) => s.seat === seat)?.username ?? `Seat ${seat}`;
}

export default function Table() {
  const { tableId = "" } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { status, seats, view, error, settled, aborted, send, dismissError } = useGameSocket(tableId);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hintMessage, setHintMessage] = useState<string | null>(null);

  const mySeat = useMemo<Seat | null>(() => {
    if (view) return view.viewer;
    if (!seats || !user) return null;
    return seats.find((s) => s.userId === user.id)?.seat ?? null;
  }, [view, seats, user]);

  // Reset card selection only when the hand's actual contents change (a new
  // deal, or our own play going through) — not on every unrelated broadcast.
  const handKey = view && "hand" in view ? view.hand.map((c) => c.id).join(",") : "";
  useEffect(() => {
    setSelected(new Set());
  }, [handKey]);

  // Auto-dismiss the error toast.
  useEffect(() => {
    if (!error) return;
    const t = setTimeout(dismissError, 4000);
    return () => clearTimeout(t);
  }, [error, dismissError]);

  // Auto-dismiss the hint's "nothing beats it" message.
  useEffect(() => {
    if (!hintMessage) return;
    const t = setTimeout(() => setHintMessage(null), 2500);
    return () => clearTimeout(t);
  }, [hintMessage]);

  // Settlement includes our fresh balance — push it into the header immediately.
  useEffect(() => {
    if (settled?.newBalance !== undefined) void refresh();
  }, [settled, refresh]);

  const toggleCard = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // Any real game action supersedes a still-showing hint message.
  const sendAction = (message: ClientMessage) => {
    setHintMessage(null);
    send(message);
  };

  const handleHint = () => {
    if (!view || view.phase !== "playing") return;
    // `lastPlay` is null both while genuinely leading a fresh trick AND right
    // after a trick resets from two passes (the engine clears it and hands
    // the turn back to the leader) — either way it means "beat nothing,
    // lead freely", which is exactly the `lastPlay: Combo | null` contract
    // suggestPlay expects.
    const toBeat = view.lastPlay ? view.lastPlay.combo : null;
    const suggestion = suggestPlay(view.hand, toBeat);
    if (suggestion) {
      setSelected(new Set(suggestion.map((c) => c.id)));
    } else {
      setSelected(new Set());
      setHintMessage("No playable hand — pass");
    }
  };

  const mySeatRow = mySeat !== null ? seats?.find((s) => s.seat === mySeat) : undefined;
  const amReady = mySeatRow?.ready ?? false;
  // An aborted table never resumes (see GameTableDO's abortHand doc comment)
  // — ready-up is refused server-side too, but hiding it here avoids a
  // pointless round trip that would just come back as a "table-aborted" error.
  const canReadyUp =
    !aborted && seats !== null && seats.length === 3 && (view === null || view.phase === "finished");

  // The settled overlay only ever shows alongside a "finished" view (see the
  // reducer's round-keyed clearing of `settled`), but guard anyway rather
  // than assume it during a reconnect race.
  const finishedView = view?.phase === "finished" ? view : null;
  const viewerIsLandlord = finishedView !== null && finishedView.viewer === finishedView.landlord;
  const viewerWonHand = finishedView !== null && (finishedView.winner === "landlord") === viewerIsLandlord;

  // Leaving via the settled/aborted overlay's "Exit to lobby" is just
  // navigating — no server call needed. Navigating away unmounts Table, and
  // useGameSocket's cleanup effect closes the socket.
  const handleExitToLobby = () => navigate(DOUDIZHU_LOBBY_PATH);

  // The mid-hand "Leave table" control, unlike Exit to lobby above, tells the
  // server first so an active hand aborts for everyone instead of just
  // waiting out a 30s disconnect grace for no reason. Fire-and-forget: no
  // response is awaited beyond the send itself (the socket is about to close
  // anyway once navigation unmounts Table).
  const handleLeaveTable = () => {
    send({ type: "leave" });
    navigate("/");
  };

  const leftSeat = mySeat !== null ? (((mySeat + 1) % 3) as Seat) : null;
  const rightSeat = mySeat !== null ? (((mySeat + 2) % 3) as Seat) : null;

  return (
    <div className="table-page">
      <div className="table-topbar">
        <button
          type="button"
          className="button button--ghost button--small"
          onClick={handleLeaveTable}
        >
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
        <div className="table-opponents-row">
          {leftSeat !== null && <OpponentSeat seat={leftSeat} seats={seats} view={view} />}
          {view && view.phase === "playing" && (
            <div className="table-bottomcards" aria-label="Bottom cards">
              <span className="table-bottomcards__label">Bottom cards</span>
              <div className="table-bottomcards__row">
                {view.landlordCards.map((c) => (
                  <PlayingCard key={c.id} card={c} small />
                ))}
              </div>
            </div>
          )}
          {rightSeat !== null && <OpponentSeat seat={rightSeat} seats={seats} view={view} />}
        </div>

        <div className="table-center card">
          <CenterArea seats={seats} view={view} />
        </div>

        {view && "hand" in view && (
          <div className="table-hand">
            {sortForHand(view.hand).map((card) => (
              <PlayingCard
                key={card.id}
                card={card}
                selected={selected.has(card.id)}
                onClick={
                  view.phase === "playing" && mySeat === view.currentTurn
                    ? () => toggleCard(card.id)
                    : undefined
                }
              />
            ))}
          </div>
        )}

        {hintMessage && (
          <p className="hint-toast" role="status">
            {hintMessage}
          </p>
        )}

        <div className="table-actions">
          {view?.phase === "bidding" && mySeat === view.currentBidder && (
            <>
              {([1, 2, 3] as const).map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className="button button--primary"
                  disabled={amount <= view.highestBid}
                  onClick={() => sendAction({ type: "bid", amount })}
                >
                  Bid {amount}
                </button>
              ))}
              <button type="button" className="button" onClick={() => sendAction({ type: "pass" })}>
                Pass
              </button>
            </>
          )}

          {view?.phase === "playing" && mySeat === view.currentTurn && (
            <>
              <button
                type="button"
                className="button"
                disabled={view.lastPlay === null}
                onClick={() => sendAction({ type: "pass" })}
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
                onClick={() => sendAction({ type: "play", cardIds: [...selected] })}
              >
                Play
              </button>
            </>
          )}

          {canReadyUp && !settled && (
            <button
              type="button"
              className="button button--primary"
              disabled={amReady}
              onClick={() => sendAction({ type: "ready" })}
            >
              {amReady ? "Waiting for others…" : view?.phase === "finished" ? "Ready for next hand" : "Ready"}
            </button>
          )}
        </div>
      </div>

      {settled && !aborted && (
        <div className="settled-overlay">
          <div className="settled-card card">
            <h2 className={`modal__title settled-card__winner ${viewerWonHand ? "settled-card__winner--gold" : ""}`}>
              {finishedView === null
                ? "Hand settled"
                : finishedView.winner === "landlord"
                  ? "Landlord Wins"
                  : "Peasants Win"}
            </h2>
            <ul>
              {SEATS.map((seat) => (
                <li key={seat}>
                  {seatLabel(seats, seat)}: {formatDelta(settled.deltas[seat])}
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
                onClick={() => sendAction({ type: "ready" })}
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

function OpponentSeat({
  seat,
  seats,
  view,
}: {
  seat: Seat;
  seats: readonly SeatStatus[] | null;
  view: ReturnType<typeof useGameSocket>["view"];
}) {
  const row = seats?.find((s) => s.seat === seat);
  const count = view && "handCounts" in view ? view.handCounts[seat] : null;
  const isLandlord = view !== null && "landlord" in view && view.landlord === seat;
  const isHighBidder = view?.phase === "bidding" && view.highestBidder === seat;

  return (
    <div className="table-opponent">
      <div className="table-opponent__cards">
        {count !== null && Array.from({ length: count }).map((_, i) => <CardBack key={i} small />)}
      </div>
      <div className="table-opponent__info">
        <span
          className={`status-dot ${row?.connected ? "status-dot--online" : "status-dot--offline"}`}
          aria-label={row?.connected ? "connected" : "disconnected"}
        />
        <span className="table-opponent__name">{row?.username ?? "Waiting…"}</span>
        {count !== null && <span className="table-opponent__count">({count})</span>}
        {isLandlord && <span title="Landlord">👑</span>}
        {isHighBidder && <span title="Highest bidder">🎯</span>}
        {row?.ready && !view && <span className="ready-badge">Ready</span>}
      </div>
    </div>
  );
}

function CenterArea({
  seats,
  view,
}: {
  seats: readonly SeatStatus[] | null;
  view: ReturnType<typeof useGameSocket>["view"];
}) {
  if (!view) {
    const filled = seats?.length ?? 0;
    if (filled < 3) {
      return <p className="table-center__hint">Waiting for players ({filled}/3 seated)…</p>;
    }
    return <p className="table-center__hint">All seats filled — ready up to start the hand.</p>;
  }

  switch (view.phase) {
    case "bidding":
      return (
        <div>
          <p className="table-center__hint">{view.landlordCardCount} bottom cards, face down</p>
          <div className="table-cardrow">
            {Array.from({ length: view.landlordCardCount }).map((_, i) => (
              <CardBack key={i} />
            ))}
          </div>
          <p>
            Highest bid: {view.highestBid || "none"}
            {view.highestBidder !== null && ` — ${seatLabel(seats, view.highestBidder)}`}
          </p>
          <p className="table-center__turn">
            {view.currentBidder === view.viewer
              ? "Your turn to bid"
              : `Waiting on ${seatLabel(seats, view.currentBidder)}`}
          </p>
        </div>
      );
    case "playing":
      return (
        <div>
          <div>
            {view.lastPlay ? (
              <div className="table-cardrow table-cardrow--lastplay">
                {view.lastPlay.combo.cards.map((c) => (
                  <PlayingCard key={c.id} card={c} />
                ))}
              </div>
            ) : (
              <p className="table-center__hint">Free lead — play anything</p>
            )}
          </div>
          <p className="table-center__turn">
            {view.currentTurn === view.viewer ? "Your turn" : `Waiting on ${seatLabel(seats, view.currentTurn)}`}
          </p>
        </div>
      );
    case "finished":
      return (
        <div>
          {view.isSpring && <p className="table-center__hint">Spring — the landlord swept the farmers.</p>}
          {view.isAntiSpring && (
            <p className="table-center__hint">Anti-spring — the farmers shut out the landlord.</p>
          )}
          {view.bombCount > 0 && <p className="table-center__hint">{view.bombCount} bomb(s) played</p>}
        </div>
      );
    case "redeal":
      return <p className="table-center__hint">All players passed — reshuffling for a new hand…</p>;
    default:
      return null;
  }
}
