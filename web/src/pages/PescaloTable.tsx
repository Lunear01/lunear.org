import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CardBack, PlayingCard } from "../components/PlayingCard";
import { useAuth } from "../context/AuthContext";
import { SeatAura } from "../skins/effects/SeatAura";
import { SkinBurst } from "../skins/effects/SkinBurst";
import { SkinMoment } from "../skins/effects/SkinMoment";
import { useFreshKey } from "../skins/effects/useFreshKey";
import { seatSkin } from "../skins/SkinArt";
import { rankLabel, sortForHand } from "../ws/cards";
import type { Books, ErrorCode, ErrorMessage, GameEvent, RedactedView, Seat, SeatStatus } from "../ws/pescalo-types";
import { usePescaloSocket } from "../ws/usePescaloSocket";
import "../styles/pescalo.css";

const PESCALO_LOBBY_PATH = "/lobby/pescalo";

// Mirrors the registry's seat bounds — a hand starts once MIN_PLAYERS are seated and ready.
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 5;
const SEATS: readonly Seat[] = [0, 1, 2, 3, 4];

/** Opponent card backs drawn at most; the count label carries the true number. */
const MAX_BACKS = 10;

/** How long the final books stay on the felt before the settlement panel covers them. */
const FINAL_HOLD_MS = 2500;

const FRIENDLY_ERROR: Record<ErrorCode, string> = {
  "wrong-phase": "That action isn't allowed right now.",
  "not-your-turn": "It's not your turn yet.",
  "invalid-target": "Pick another player to ask.",
  "invalid-rank": "That's not a rank you can ask for.",
  "rank-not-in-hand": "You can only ask for a rank you hold.",
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

function formatCredits(n: number): string {
  return n.toLocaleString();
}

function seatLabel(seats: readonly SeatStatus[] | null, seat: Seat): string {
  return seats?.find((s) => s.seat === seat)?.username ?? `Seat ${seat}`;
}

/** "7s", "Jacks", "Aces". */
function rankPlural(rank: number): string {
  const label = rankLabel(rank);
  const names: Record<string, string> = { J: "Jacks", Q: "Queens", K: "Kings", A: "Aces" };
  return names[label] ?? `${label}s`;
}

function narrate(event: GameEvent, seats: readonly SeatStatus[] | null, viewer: Seat | null): string {
  const name = (seat: Seat) => (seat === viewer ? "You" : seatLabel(seats, seat));
  switch (event.type) {
    case "asked":
      return `${name(event.seat)} asked ${name(event.target)} for ${rankPlural(event.rank)}`;
    case "hit":
      return `${name(event.target)} handed over ${event.count}`;
    case "go-fish":
      return "Go fish!";
    case "drew-match":
      return `${name(event.seat)} fished the ${rankLabel(event.rank)} — goes again`;
    case "drew-hidden":
      return `${name(event.seat)} drew a card`;
    case "book":
      return `${name(event.seat)} booked the ${rankPlural(event.rank)}`;
    case "refill":
      return `${name(event.seat)} drew a card to keep playing`;
    case "skipped":
      return `${name(event.seat)} has no cards — skipped`;
  }
}

export default function PescaloTable() {
  const { tableId = "" } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { status, round, seats, view, error, settled, aborted, send, dismissError } = usePescaloSocket(tableId);

  const [selectedRank, setSelectedRank] = useState<number | null>(null);
  const [target, setTarget] = useState<Seat | null>(null);

  const mySeat = useMemo<Seat | null>(() => {
    if (view) return view.viewer;
    if (!seats || !user) return null;
    return seats.find((s) => s.userId === user.id)?.seat ?? null;
  }, [view, seats, user]);

  // Drop a selected rank once it leaves the hand (booked or never held after a redeal).
  const handKey = view?.phase === "playing" ? view.hand.map((c) => c.id).join(",") : "";
  useEffect(() => {
    if (view?.phase !== "playing") {
      setSelectedRank(null);
      return;
    }
    setSelectedRank((rank) => (rank !== null && view.hand.some((c) => c.rank === rank) ? rank : null));
  }, [handKey, view]);

  // Drop a target that is no longer an active opponent.
  useEffect(() => {
    if (view?.phase !== "playing") {
      setTarget(null);
      return;
    }
    setTarget((t) => (t !== null && t !== mySeat && view.activeSeats.includes(t) ? t : null));
  }, [view, mySeat]);

  useEffect(() => {
    if (!error) return;
    const t = setTimeout(dismissError, 4000);
    return () => clearTimeout(t);
  }, [error, dismissError]);

  useEffect(() => {
    if (settled?.newBalance !== undefined) void refresh();
  }, [settled, refresh]);

  const [settledVisible, setSettledVisible] = useState(false);
  useEffect(() => {
    setSettledVisible(false);
    if (!settled) return;
    const t = setTimeout(() => setSettledVisible(true), FINAL_HOLD_MS);
    return () => clearTimeout(t);
  }, [settled]);

  const mySeatRow = mySeat !== null ? seats?.find((s) => s.seat === mySeat) : undefined;
  const amReady = mySeatRow?.ready ?? false;
  const canReadyUp =
    !aborted && seats !== null && seats.length >= MIN_PLAYERS && (view === null || view.phase === "finished");

  const myInGame = view !== null && mySeat !== null && view.activeSeats.includes(mySeat);
  const myTurn = view?.phase === "playing" && mySeat === view.currentTurn;
  const finishedView = view?.phase === "finished" ? view : null;
  const viewerWon = finishedView !== null && finishedView.winners.includes(finishedView.viewer);

  const handleExitToLobby = () => navigate(PESCALO_LOBBY_PATH);

  // Mid-hand leave tells the server first so the hand aborts for everyone at once.
  const handleLeaveTable = () => {
    send({ type: "leave" });
    navigate("/");
  };

  const handleAsk = () => {
    if (selectedRank === null || target === null) return;
    send({ type: "ask", target, rank: selectedRank });
  };

  // Opponents read left-to-right from the seat after mine.
  const orderedOpponents = useMemo<readonly Seat[]>(() => {
    const base = mySeat ?? 0;
    return [1, 2, 3, 4].map((offset) => ((base + offset) % MAX_PLAYERS) as Seat);
  }, [mySeat]);

  // A target is pickable on my turn, among active opponents who are seated.
  const canPickTarget = (seat: Seat) =>
    myTurn && view !== null && view.activeSeats.includes(seat) && seats?.some((s) => s.seat === seat) === true;

  const askLabel =
    selectedRank === null
      ? "Pick a rank"
      : target === null
        ? `Ask who for ${rankPlural(selectedRank)}?`
        : `Ask ${seatLabel(seats, target)} for ${rankPlural(selectedRank)}`;

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
        <div className="table-opponents-row pc-opponents">
          {orderedOpponents.map((seat) => (
            <PescaloOpponentSeat
              key={seat}
              seat={seat}
              seats={seats}
              view={view}
              selected={target === seat}
              onPick={canPickTarget(seat) ? () => setTarget(seat) : undefined}
            />
          ))}
        </div>

        <div className="table-center card">
          <PescaloCenter seats={seats} view={view} viewer={mySeat} />
        </div>

        {view?.phase === "playing" && (
          <>
            {!myInGame && (
              <div className="pc-self-status">
                <span>Hand in progress — you join the next one</span>
              </div>
            )}
            {myInGame && mySeat !== null && view.books[mySeat].length > 0 && (
              <BookChips books={view.books} seat={mySeat} label="Your books" />
            )}
            <div className="table-hand">
              {sortForHand(view.hand).map((card, i) => (
                <PlayingCard
                  key={card.id}
                  card={card}
                  skin={mySeatRow?.cardSkin}
                  index={i}
                  selected={selectedRank === card.rank}
                  // Selectable off-turn so an ask can be lined up while waiting.
                  onClick={() => setSelectedRank((r) => (r === card.rank ? null : card.rank))}
                />
              ))}
            </div>
          </>
        )}

        <div className="table-actions">
          {myTurn && (
            <button
              type="button"
              className="button button--primary"
              disabled={selectedRank === null || target === null}
              onClick={handleAsk}
            >
              {askLabel}
            </button>
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

      {view && <PescaloMoment seats={seats} view={view} round={round} />}

      {settled && !aborted && settledVisible && (
        <div className="settled-overlay">
          <div className="settled-card card">
            <h2 className={`modal__title settled-card__winner ${viewerWon ? "settled-card__winner--gold" : ""}`}>
              {finishedView
                ? finishedView.winners.length > 1
                  ? "Tie for most books"
                  : `${seatLabel(seats, finishedView.winners[0])} wins`
                : "Hand settled"}
            </h2>
            <ul>
              {(finishedView?.activeSeats ?? SEATS).map((seat) => (
                <li key={seat}>
                  {seatLabel(seats, seat)}
                  {finishedView && (
                    <span className="pc-settled__books"> · {finishedView.books[seat].length} books</span>
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

function BookChips({ books, seat, label }: { books: Books; seat: Seat; label?: string }) {
  if (books[seat].length === 0) return null;
  return (
    <div className="pc-books" aria-label={label ?? "Books"}>
      {label && <span className="pc-books__label">{label}</span>}
      {books[seat].map((rank) => (
        <span key={rank} className="pc-book" title={`Book of ${rankPlural(rank)}`}>
          {rankLabel(rank)}
        </span>
      ))}
    </div>
  );
}

function PescaloOpponentSeat({
  seat,
  seats,
  view,
  selected,
  onPick,
}: {
  seat: Seat;
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
  selected: boolean;
  onPick?: () => void;
}) {
  const row = seats?.find((s) => s.seat === seat);
  const inGame = view === null || view.activeSeats.includes(seat);
  const count = view?.phase === "playing" && inGame ? view.handCounts[seat] : null;
  const isTurn = view?.phase === "playing" && view.currentTurn === seat;

  if (!row) {
    return (
      <div className="table-opponent pc-opponent pc-opponent--empty">
        <div className="table-opponent__info">
          <span className="table-opponent__name">Open seat</span>
        </div>
      </div>
    );
  }

  const classes = [
    "table-opponent",
    "pc-opponent",
    isTurn && "pc-opponent--turn",
    selected && "pc-opponent--selected",
    onPick && "pc-opponent--pickable",
  ]
    .filter(Boolean)
    .join(" ");

  const body = (
    <>
      <SeatAura skin={row.cardSkin} active={isTurn} />
      <div className="table-opponent__cards">
        {count !== null && count > 0
          ? Array.from({ length: Math.min(count, MAX_BACKS) }).map((_, i) => <CardBack key={i} small skin={row?.cardSkin} index={i} />)
          : null}
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
        {isTurn && <span title="Current turn">🎣</span>}
        {row.ready && !view && <span className="ready-badge">Ready</span>}
        {view !== null && !inGame && <span className="table-opponent__count">next hand</span>}
      </div>
      {view !== null && inGame && <BookChips books={view.books} seat={seat} />}
    </>
  );

  // Pickable seats are real buttons so a tap (or Enter) picks the target.
  if (onPick) {
    return (
      <button type="button" className={classes} onClick={onPick} aria-pressed={selected}>
        {body}
      </button>
    );
  }
  return <div className={classes}>{body}</div>;
}

/** The sole winner's moment. Mounted from the first view so only wins seen live fire. */
function PescaloMoment({
  seats,
  view,
  round,
}: {
  seats: readonly SeatStatus[] | null;
  view: RedactedView;
  round: number;
}) {
  const winner = view.phase === "finished" && view.winners.length === 1 ? view.winners[0] : null;
  const held = winner !== null ? { key: `win-${round}`, seat: winner } : null;
  const momentKey = useFreshKey(held?.key ?? null);
  return (
    <SkinMoment
      skin={seatSkin(seats, held?.seat ?? -1)}
      momentKey={momentKey}
      label={held ? `${seatLabel(seats, held.seat)} wins` : ""}
    />
  );
}

function PescaloCenter({
  seats,
  view,
  viewer,
}: {
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
  viewer: Seat | null;
}) {
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
  return <PescaloView seats={seats} view={view} viewer={viewer} />;
}

// Split from PescaloCenter so the burst key's mount-time snapshot is the first view, not the empty table.
function PescaloView({
  seats,
  view,
  viewer,
}: {
  seats: readonly SeatStatus[] | null;
  view: RedactedView;
  viewer: Seat | null;
}) {
  // Books are rank chips, not cards: a completed book is the table's play burst.
  const book = view.lastEvents.find((e) => e.type === "book");
  const burstKey = useFreshKey(book?.type === "book" ? `${book.seat}-${book.rank}` : null);
  const burst = <SkinBurst skin={seatSkin(seats, book?.type === "book" ? book.seat : -1)} burstKey={burstKey} />;

  const feed = (
    <ul className="pc-feed" aria-live="polite">
      {view.lastEvents.map((event, i) => (
        <li key={i} className={`pc-feed__item pc-feed__item--${event.type}`}>
          {narrate(event, seats, viewer)}
        </li>
      ))}
    </ul>
  );

  if (view.phase === "playing") {
    return (
      <div className="pc-center fx-host">
        {burst}
        <div className="pc-pool" aria-label={`${view.poolCount} cards in the pool`}>
          {view.poolCount > 0 ? <CardBack /> : <span className="pc-pool__empty" />}
          <span className="pc-pool__count">{view.poolCount} in the pool</span>
        </div>
        {feed}
        <p className="table-center__turn">
          {view.currentTurn === view.viewer ? "Your turn — pick a rank, then who to ask" : `Waiting on ${seatLabel(seats, view.currentTurn)}`}
        </p>
      </div>
    );
  }

  return (
    <div className="pc-center fx-host">
      {burst}
      {feed}
      <p className="table-center__turn">
        {view.winners.length > 1
          ? `Tie: ${view.winners.map((s) => seatLabel(seats, s)).join(", ")}`
          : `${seatLabel(seats, view.winners[0])} takes the most books`}
      </p>
      <div className="pc-final-books">
        {view.activeSeats.map((seat) => (
          <div key={seat} className="pc-final-books__row">
            <span className="pc-final-books__name">{seatLabel(seats, seat)}</span>
            <BookChips books={view.books} seat={seat} />
            {view.books[seat].length === 0 && <span className="table-center__hint">no books</span>}
          </div>
        ))}
      </div>
    </div>
  );
}
