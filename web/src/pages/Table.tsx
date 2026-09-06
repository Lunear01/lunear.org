import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { CardBack, PlayingCard } from "../components/PlayingCard";
import { useAuth } from "../context/AuthContext";
import { sortForHand } from "../ws/cards";
import type { ErrorCode, ErrorMessage, PlayRecord, Seat, SeatStatus } from "../ws/types";
import { useGameSocket } from "../ws/useGameSocket";

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

function Countdown({ deadline }: { deadline: number | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (deadline === null) return;
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [deadline]);
  if (deadline === null) return null;
  const seconds = Math.max(0, Math.ceil((deadline - now) / 1000));
  return <span className="table-countdown">{seconds}s</span>;
}

export default function Table() {
  const { tableId = "" } = useParams<{ tableId: string }>();
  const { user, refresh } = useAuth();
  const { status, seats, view, turnDeadline, error, settled, send, dismissError } = useGameSocket(tableId);

  const [selected, setSelected] = useState<Set<string>>(new Set());

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

  const mySeatRow = mySeat !== null ? seats?.find((s) => s.seat === mySeat) : undefined;
  const amReady = mySeatRow?.ready ?? false;
  const canReadyUp = seats !== null && seats.length === 3 && (view === null || view.phase === "finished");

  const leftSeat = mySeat !== null ? (((mySeat + 1) % 3) as Seat) : null;
  const rightSeat = mySeat !== null ? (((mySeat + 2) % 3) as Seat) : null;

  return (
    <div className="table-page">
      <div className="table-topbar">
        <Link to="/" className="button button--ghost button--small">
          Leave table
        </Link>
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
          {rightSeat !== null && <OpponentSeat seat={rightSeat} seats={seats} view={view} />}
        </div>

        <div className="table-center card">
          <CenterArea seats={seats} view={view} turnDeadline={turnDeadline} />
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

        <div className="table-actions">
          {view?.phase === "bidding" && mySeat === view.currentBidder && (
            <>
              {([1, 2, 3] as const).map((amount) => (
                <button
                  key={amount}
                  type="button"
                  className="button button--primary"
                  disabled={amount <= view.highestBid}
                  onClick={() => send({ type: "bid", amount })}
                >
                  Bid {amount}
                </button>
              ))}
              <button type="button" className="button" onClick={() => send({ type: "pass" })}>
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
                onClick={() => send({ type: "pass" })}
              >
                Pass
              </button>
              <button
                type="button"
                className="button button--primary"
                disabled={selected.size === 0}
                onClick={() => send({ type: "play", cardIds: [...selected] })}
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
              onClick={() => send({ type: "ready" })}
            >
              {amReady ? "Waiting for others…" : view?.phase === "finished" ? "Ready for next hand" : "Ready"}
            </button>
          )}
        </div>
      </div>

      {settled && (
        <div className="settled-overlay">
          <div className="settled-card card">
            <h2 className="modal__title">Hand settled</h2>
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
            <button
              type="button"
              className="button button--primary"
              disabled={amReady}
              onClick={() => send({ type: "ready" })}
            >
              {amReady ? "Waiting for others…" : "Ready for next hand"}
            </button>
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

function HistoryFeed({ history }: { history: readonly PlayRecord[] }) {
  if (history.length === 0) return null;
  const recent = history.slice(-5).reverse();
  return (
    <ul className="table-history">
      {recent.map((entry, i) => (
        <li key={history.length - i}>
          <span className="table-history__seat">Seat {entry.seat}</span>
          {entry.combo ? (
            <span className="table-cardrow table-cardrow--tiny">
              {entry.combo.cards.map((c) => (
                <PlayingCard key={c.id} card={c} small />
              ))}
            </span>
          ) : (
            <span>passed</span>
          )}
        </li>
      ))}
    </ul>
  );
}

function CenterArea({
  seats,
  view,
  turnDeadline,
}: {
  seats: readonly SeatStatus[] | null;
  view: ReturnType<typeof useGameSocket>["view"];
  turnDeadline: number | null;
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
              : `Waiting on ${seatLabel(seats, view.currentBidder)}`}{" "}
            <Countdown deadline={turnDeadline} />
          </p>
        </div>
      );
    case "playing":
      return (
        <div>
          <div>
            <p className="table-center__hint">Bottom cards</p>
            <div className="table-cardrow">
              {view.landlordCards.map((c) => (
                <PlayingCard key={c.id} card={c} small />
              ))}
            </div>
          </div>
          <div>
            {view.lastPlay ? (
              <>
                <p className="table-center__hint">{seatLabel(seats, view.lastPlay.seat)} played</p>
                <div className="table-cardrow">
                  {view.lastPlay.combo.cards.map((c) => (
                    <PlayingCard key={c.id} card={c} small />
                  ))}
                </div>
              </>
            ) : (
              <p className="table-center__hint">Free lead — play anything</p>
            )}
          </div>
          <p className="table-center__turn">
            {view.currentTurn === view.viewer ? "Your turn" : `Waiting on ${seatLabel(seats, view.currentTurn)}`}{" "}
            <Countdown deadline={turnDeadline} />
          </p>
          <HistoryFeed history={view.history} />
        </div>
      );
    case "finished":
      return (
        <div>
          <p>{view.winner === "landlord" ? "Landlord wins!" : "Farmers win!"}</p>
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
