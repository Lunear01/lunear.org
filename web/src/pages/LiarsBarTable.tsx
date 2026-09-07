import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { CardBack } from "../components/PlayingCard";
import { LiarsBarCard } from "../components/LiarsBarCard";
import { useAuth } from "../context/AuthContext";
import type {
  ClientMessage,
  ErrorCode,
  ErrorMessage,
  PublicPlayerStatus,
  RedactedRoundEndView,
  RedactedView,
  Seat,
  SeatStatus,
  TableRank,
} from "../ws/liarsbar-types";
import { useLiarsBarSocket } from "../ws/useLiarsBarSocket";

// This table page is liarsbar-specific, so the lobby it returns to on exit
// is hardcoded rather than derived (mirrors Table.tsx's DOUDIZHU_LOBBY_PATH).
const LIARSBAR_LOBBY_PATH = "/lobby/liarsbar";

const SEATS: readonly Seat[] = [0, 1, 2, 3];
const CHAMBERS = 6;
const MAX_PLAY = 3;

const TABLE_RANK_NAMES: Record<TableRank, string> = {
  Q: "Queens",
  K: "Kings",
  A: "Aces",
};

const FRIENDLY_ERROR: Record<ErrorCode, string> = {
  "wrong-phase": "That action isn't allowed right now.",
  "not-your-turn": "It's not your turn yet.",
  "empty-play": "Select at least one card to play.",
  "too-many-cards": "You can play at most 3 cards.",
  "invalid-cards": "That's not a valid selection.",
  "cards-not-in-hand": "Those cards aren't in your hand.",
  "nothing-to-challenge": "There's no play to challenge right now.",
  "bad-message": "Something went wrong sending that action.",
  "table-full": "This table is full.",
  "not-initialized": "This table isn't set up yet.",
  "game-in-progress": "A round is already in progress.",
  "no-active-hand": "There's no round in progress right now.",
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

/** Revolver-chamber dots: filled left-to-right, one per spin so far. */
function ChamberDots({ pulls }: { pulls: number }) {
  return (
    <div className="lb-chamber" aria-label={`${pulls} of ${CHAMBERS} chambers fired`}>
      {Array.from({ length: CHAMBERS }).map((_, i) => (
        <span key={i} className={`lb-chamber__dot ${i < pulls ? "lb-chamber__dot--filled" : ""}`} aria-hidden="true" />
      ))}
    </div>
  );
}

export default function LiarsBarTable() {
  const { tableId = "" } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { status, seats, view, error, settled, aborted, send, dismissError, continueRoundEnd, revealSeq } =
    useLiarsBarSocket(tableId);

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
      if (next.has(id)) {
        next.delete(id);
      } else if (next.size < MAX_PLAY) {
        // A 4th selection is a guaranteed server rejection (max 3 cards) —
        // just ignore the tap rather than round-tripping to find that out.
        next.add(id);
      }
      return next;
    });
  };

  const mySeatRow = mySeat !== null ? seats?.find((s) => s.seat === mySeat) : undefined;
  const amReady = mySeatRow?.ready ?? false;
  // An aborted table never resumes — ready-up is refused server-side too,
  // but hiding it here avoids a pointless round trip.
  const canReadyUp =
    !aborted && seats !== null && seats.length === SEATS.length && (view === null || view.phase === "finished");

  const myStatus: PublicPlayerStatus | null = view && mySeat !== null ? view.players[mySeat] : null;

  const finishedView = view?.phase === "finished" ? view : null;
  const roundEndView = view?.phase === "roundEnd" ? view : null;

  const handleExitToLobby = () => navigate(LIARSBAR_LOBBY_PATH);

  // Mid-round "Leave table" tells the server first so an active hand aborts
  // for everyone instead of waiting out the 30s disconnect grace for no
  // reason. Fire-and-forget: navigation unmounts the page right after.
  const handleLeaveTable = () => {
    send({ type: "leave" });
    navigate("/");
  };

  // Order the 3 opponents starting from the seat after mine, so they read
  // left-to-right around the table the same way every time.
  const orderedOpponents = useMemo<readonly Seat[]>(() => {
    const base = mySeat ?? 0;
    return [1, 2, 3].map((offset) => ((base + offset) % 4) as Seat);
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
        <div className="table-opponents-row">
          {orderedOpponents.map((seat) => (
            <LiarsBarOpponentSeat key={seat} seat={seat} seats={seats} view={view} />
          ))}
        </div>

        <div className="table-center card">
          <LiarsBarCenter seats={seats} view={view} />
        </div>

        {view && "hand" in view && (
          <>
            {myStatus && (
              <div className="lb-self-status">
                <ChamberDots pulls={myStatus.pulls} />
                {!myStatus.alive && <span>You&rsquo;re eliminated — spectating</span>}
              </div>
            )}
            <div className="table-hand">
              {view.hand.map((card) => (
                <LiarsBarCard
                  key={card.id}
                  card={card}
                  selected={selected.has(card.id)}
                  onClick={
                    view.phase === "playing" && mySeat === view.currentTurn ? () => toggleCard(card.id) : undefined
                  }
                />
              ))}
            </div>
          </>
        )}

        <div className="table-actions">
          {view?.phase === "playing" && mySeat === view.currentTurn && (
            <>
              <button
                type="button"
                className="button button--danger"
                disabled={view.lastPlay === null}
                onClick={() => send({ type: "challenge" })}
              >
                Challenge
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
              {amReady ? "Waiting for others…" : view?.phase === "finished" ? "Ready for next game" : "Ready"}
            </button>
          )}
        </div>
      </div>

      {roundEndView && (
        <LiarsBarRevealOverlay key={revealSeq} view={roundEndView} seats={seats} onContinue={continueRoundEnd} />
      )}

      {settled && !aborted && finishedView && (
        <div className="settled-overlay">
          <div className="settled-card card">
            <h2 className="modal__title settled-card__winner settled-card__winner--gold">
              {seatLabel(seats, finishedView.winner)} wins the pot
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
                onClick={() => send({ type: "ready" })}
              >
                {amReady ? "Waiting for others…" : "Ready again"}
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

function LiarsBarOpponentSeat({
  seat,
  seats,
  view,
}: {
  seat: Seat;
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
}) {
  const row = seats?.find((s) => s.seat === seat);
  const count = view && "handCounts" in view ? view.handCounts[seat] : null;
  const player = view ? view.players[seat] : null;
  const isDead = player !== null && !player.alive;
  const isTurn = view?.phase === "playing" && view.currentTurn === seat;

  return (
    <div className={`table-opponent ${isDead ? "lb-seat--dead" : ""}`}>
      <div className="table-opponent__cards">
        {isDead ? (
          <span className="lb-skull" aria-label="eliminated">
            💀
          </span>
        ) : (
          count !== null && Array.from({ length: count }).map((_, i) => <CardBack key={i} small />)
        )}
      </div>
      <div className="table-opponent__info">
        <span
          className={`status-dot ${row?.connected ? "status-dot--online" : "status-dot--offline"}`}
          aria-label={row?.connected ? "connected" : "disconnected"}
        />
        <span className="table-opponent__name">{row?.username ?? "Waiting…"}</span>
        {row?.userId !== null && row !== undefined && (
          <span className={`seat-credits ${row.credits < 0 ? "seat-credits--negative" : ""}`}>
            {formatCredits(row.credits)}
          </span>
        )}
        {count !== null && !isDead && <span className="table-opponent__count">({count})</span>}
        {isTurn && <span title="Current turn">🎯</span>}
        {row?.ready && !view && <span className="ready-badge">Ready</span>}
      </div>
      {player !== null && <ChamberDots pulls={player.pulls} />}
    </div>
  );
}

function LiarsBarCenter({ seats, view }: { seats: readonly SeatStatus[] | null; view: RedactedView | null }) {
  if (!view) {
    const filled = seats?.length ?? 0;
    if (filled < SEATS.length) {
      return <p className="table-center__hint">Waiting for players ({filled}/4 seated)…</p>;
    }
    return <p className="table-center__hint">All seats filled — ready up to start.</p>;
  }

  switch (view.phase) {
    case "playing":
      return (
        <div>
          <p className="lb-tablerank">Table: {TABLE_RANK_NAMES[view.tableRank]}</p>
          {view.lastPlay ? (
            <div className="lb-lastplay">
              <div className="table-cardrow">
                {Array.from({ length: view.lastPlay.cardCount }).map((_, i) => (
                  <CardBack key={i} />
                ))}
              </div>
              <p className="table-center__hint">
                {seatLabel(seats, view.lastPlay.seat)} played {view.lastPlay.cardCount} card
                {view.lastPlay.cardCount === 1 ? "" : "s"}
              </p>
            </div>
          ) : (
            <p className="table-center__hint">Free lead — play 1-3 cards</p>
          )}
          <p className="table-center__turn">
            {view.currentTurn === view.viewer ? "Your turn" : `Waiting on ${seatLabel(seats, view.currentTurn)}`}
          </p>
        </div>
      );
    case "roundEnd":
      // The dramatic reveal renders as its own overlay (LiarsBarRevealOverlay) —
      // this stays quiet underneath while that's on screen.
      return <p className="table-center__hint">Resolving the challenge…</p>;
    case "finished":
      return <p className="table-center__hint">Game over.</p>;
    default:
      return null;
  }
}

function LiarsBarRevealOverlay({
  view,
  seats,
  onContinue,
}: {
  view: RedactedRoundEndView;
  seats: readonly SeatStatus[] | null;
  onContinue: () => void;
}) {
  const [stage, setStage] = useState<0 | 1 | 2>(0);
  const { lastReveal } = view;
  const loserStatus = view.players[lastReveal.loserSeat];

  useEffect(() => {
    const t1 = setTimeout(() => setStage(1), 450);
    const t2 = setTimeout(() => setStage(2), 1500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, []);

  return (
    <div className="lb-reveal-overlay">
      <div className="lb-reveal-card card">
        <p className="lb-reveal__claim">
          {seatLabel(seats, lastReveal.playSeat)} claimed {lastReveal.cards.length} card
          {lastReveal.cards.length === 1 ? "" : "s"}
          {lastReveal.auto
            ? " — forced reveal, nobody left to challenge"
            : ` — challenged by ${seatLabel(seats, lastReveal.challengerSeat)}`}
        </p>

        <div className="lb-reveal__cards">
          {lastReveal.cards.map((card, i) => (
            <div
              key={card.id}
              className={`lb-flip ${stage >= 1 ? "lb-flip--revealed" : ""}`}
              style={{ transitionDelay: `${i * 90}ms` }}
            >
              <div className="lb-flip__inner">
                <div className="lb-flip__face lb-flip__face--back" aria-hidden="true" />
                <div className="lb-flip__face lb-flip__face--front">
                  <LiarsBarCard card={card} />
                </div>
              </div>
            </div>
          ))}
        </div>

        {stage >= 1 && (
          <p className={`lb-reveal__verdict ${lastReveal.wasTruthful ? "lb-reveal__verdict--truth" : "lb-reveal__verdict--lie"}`}>
            {lastReveal.wasTruthful ? "TRUTH" : "LIE"}
          </p>
        )}

        {stage >= 2 && (
          <div className="lb-reveal__roulette">
            <p className="lb-reveal__roulette-name">{seatLabel(seats, lastReveal.loserSeat)} spins the chamber…</p>
            <ChamberDots pulls={loserStatus.pulls} />
            <p
              className={`lb-reveal__outcome ${loserStatus.alive ? "lb-reveal__outcome--survived" : "lb-reveal__outcome--dead"}`}
            >
              {loserStatus.alive ? "click… survived" : "BANG — eliminated"}
            </p>
          </div>
        )}

        <button type="button" className="button button--primary lb-reveal__continue" onClick={onContinue}>
          Continue
        </button>
      </div>
    </div>
  );
}
