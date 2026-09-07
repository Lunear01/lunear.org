import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { PokerCard } from "../components/PokerCard";
import { useAuth } from "../context/AuthContext";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import type {
  Card,
  ClientMessage,
  ErrorCode,
  ErrorMessage,
  Outcome,
  PublicHandStatus,
  RedactedView,
  Seat,
  SeatStatus,
  SettledMessage,
} from "../ws/blackjack-types";
import { useBlackjackSocket } from "../ws/useBlackjackSocket";

// This table page is blackjack-specific, so the lobby it returns to on exit
// is hardcoded (mirrors PokerTable's POKER_LOBBY_PATH).
const BLACKJACK_LOBBY_PATH = "/lobby/blackjack";

const ALL_SEATS: readonly Seat[] = [0, 1, 2, 3, 4];
const MIN_SEATS_TO_START = 1;

const FRIENDLY_ERROR: Record<ErrorCode, string> = {
  "bad-message": "Something went wrong sending that action.",
  "game-in-progress": "A round is already in progress.",
  "no-active-hand": "There's no round in progress right now.",
  "wrong-phase": "That action isn't allowed right now.",
  "not-your-turn": "It's not your turn yet.",
  "cannot-double": "You can only double down on your first two cards.",
};

const OUTCOME_LABEL: Record<Outcome, string> = {
  blackjack: "Blackjack!",
  win: "Win",
  push: "Push",
  lose: "Lose",
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

/** "Soft 17" / "19" / "Bust (25)" — the one hand-total spelling used everywhere on this screen. */
function totalLabel(hand: PublicHandStatus): string {
  if (hand.busted) return `Bust (${hand.total})`;
  if (hand.natural) return "21";
  return hand.soft ? `Soft ${hand.total}` : String(hand.total);
}

/** Same auto-deal fallback grace as PokerTable — see its NEXT_HAND_GRACE_MS doc comment. */
const NEXT_HAND_GRACE_MS = 4000;

/** Live seats row first, then the socket hook's carry-forward usernames map
 * for a seat freed before its settlement line rendered (see useBlackjackSocket). */
function makeSeatLabel(seats: readonly SeatStatus[] | null, usernames: Readonly<Record<Seat, string>>) {
  return (seat: Seat): string => {
    return seats?.find((s) => s.seat === seat)?.username ?? usernames[seat] ?? `Seat ${seat}`;
  };
}

export default function BlackjackTable() {
  const { tableId = "" } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { status, handNo, seats, view, error, settled, nextHand, usernames, send, dismissError, retry } =
    useBlackjackSocket(tableId);
  const reducedMotion = usePrefersReducedMotion();

  // Ticks while a "next round in Ns" countdown is live — same rationale as PokerTable's timer.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (nextHand === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [nextHand]);

  const countdownMsLeft = nextHand !== null ? nextHand - now : null;
  const countdownActive = countdownMsLeft !== null && countdownMsLeft > -NEXT_HAND_GRACE_MS;
  const countdownSeconds = countdownMsLeft !== null ? Math.max(0, Math.ceil(countdownMsLeft / 1000)) : 0;

  const mySeat = useMemo<Seat | null>(() => {
    if (view) return view.viewer;
    if (!seats || !user) return null;
    return seats.find((s) => s.userId === user.id)?.seat ?? null;
  }, [view, seats, user]);

  const seatLabel = useMemo(() => makeSeatLabel(seats, usernames), [seats, usernames]);

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

  const mySeatRow = mySeat !== null ? seats?.find((s) => s.seat === mySeat) : undefined;
  const amReady = mySeatRow?.ready ?? false;
  const filledSeats = seats?.filter((s) => s.userId !== null).length ?? 0;

  // Unlike poker, a seated occupant skipped at deal time still receives the
  // live view (all blackjack hands are public) — being absent from
  // view.players is what marks them as sitting this round out.
  const myHand: PublicHandStatus | null = view !== null && mySeat !== null ? (view.players[mySeat] ?? null) : null;
  const skippedThisRound = view?.phase === "acting" && mySeat !== null && myHand === null;

  const canReadyUp =
    mySeat !== null && !countdownActive && (view === null || view.phase === "finished");

  const isMyTurn = view?.phase === "acting" && view.currentTurn === mySeat && myHand !== null && !myHand.done;

  const handleLeaveTable = () => {
    send({ type: "leave" });
    navigate("/");
  };
  const handleExitToLobby = () => navigate(BLACKJACK_LOBBY_PATH);

  if (status === "failed") {
    return (
      <div className="page">
        <div className="card page-loading">
          <h1 className="page__title">Table is busy or full</h1>
          <p>This table couldn&rsquo;t be joined right now — it may be mid-round or already at capacity.</p>
          <div className="pk-panel-actions">
            <button type="button" className="button button--primary" onClick={retry}>
              Retry
            </button>
            <button type="button" className="button" onClick={handleExitToLobby}>
              Back to lobby
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (seats === null) {
    return (
      <div className="page">
        <div className="card page-loading">
          <div className="spinner" aria-hidden="true" />
          <p>Connecting to table&hellip;</p>
        </div>
      </div>
    );
  }

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

      <div className="bj-felt">
        <div className="pk-center bj-dealer">
          <DealerArea
            view={view}
            filledSeats={filledSeats}
            mySeat={mySeat}
            seatLabel={seatLabel}
            skippedThisRound={skippedThisRound}
            reducedMotion={reducedMotion}
          />
        </div>

        <div className="bj-seats">
          {ALL_SEATS.map((seat) => (
            <BjSeat
              key={seat}
              seat={seat}
              seats={seats}
              view={view}
              mySeat={mySeat}
              seatLabel={seatLabel}
              settled={settled}
              countdownActive={countdownActive}
            />
          ))}
        </div>
      </div>

      <div className="pk-self">
        {myHand && (
          <p className="pk-self__committed">
            Your hand: {totalLabel(myHand)} &middot; Bet {myHand.bet.toLocaleString()}
            {myHand.doubled ? " (doubled)" : ""}
          </p>
        )}
        {mySeatRow && (
          <p className={`pk-self__credits ${mySeatRow.credits < 0 ? "pk-self__credits--negative" : ""}`}>
            Your credits: {formatCredits(mySeatRow.credits)}
          </p>
        )}

        <div className="table-actions pk-actionbar">
          {isMyTurn && myHand && (
            <>
              <button type="button" className="button button--primary" onClick={() => send({ type: "hit" })}>
                Hit
              </button>
              <button type="button" className="button" onClick={() => send({ type: "stand" })}>
                Stand
              </button>
              <button
                type="button"
                className="button"
                disabled={myHand.cards.length !== 2}
                onClick={() => send({ type: "double" })}
              >
                Double
              </button>
            </>
          )}

          {canReadyUp && (
            <button
              type="button"
              className="button button--primary"
              disabled={amReady}
              onClick={() => send({ type: "ready" })}
            >
              {amReady ? "Waiting for others…" : view === null ? "Ready" : "Ready for next round"}
            </button>
          )}
        </div>
      </div>

      {settled && countdownActive && view?.phase === "finished" && (
        <NextRoundBanner
          view={view}
          settled={settled}
          mySeat={mySeat}
          secondsLeft={countdownSeconds}
          onExit={handleExitToLobby}
        />
      )}
    </div>
  );
}

function BjSeat({
  seat,
  seats,
  view,
  mySeat,
  seatLabel,
  settled,
  countdownActive,
}: {
  seat: Seat;
  seats: readonly SeatStatus[];
  view: RedactedView | null;
  mySeat: Seat | null;
  seatLabel: (seat: Seat) => string;
  /** Null outside the post-round results phase — see BlackjackTable's own `settled`. */
  settled: SettledMessage | null;
  /** True only while the auto-deal countdown banner is showing. */
  countdownActive: boolean;
}) {
  const row = seats.find((s) => s.seat === seat);
  const hand: PublicHandStatus | undefined = view?.players[seat];
  const isMe = seat === mySeat;
  const isCurrentTurn = view?.phase === "acting" && view.currentTurn === seat;
  const isOpen = !row || row.userId === null;
  const outcome: Outcome | undefined = view?.phase === "finished" ? view.outcomes[seat] : undefined;

  // Floating delta chip + winner glow, scoped and keyed exactly like PkSeat's.
  const seatDelta = settled?.deltas[seat];
  const showResult = countdownActive && seatDelta !== undefined;
  const delta = seatDelta ?? 0;
  const isWinnerSeat = showResult && delta > 0;

  const classes = [
    "pk-seat",
    "bj-seat",
    isMe && "pk-seat--me",
    isOpen && "pk-seat--open",
    hand?.busted && "pk-seat--folded",
    isCurrentTurn && "pk-seat--turn",
    isWinnerSeat && "pk-seat--winner",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
      {showResult && delta !== 0 && (
        <span key={settled?.handNo} className={`pk-delta-chip ${delta > 0 ? "pk-delta-chip--gain" : "pk-delta-chip--loss"}`}>
          {formatDelta(delta)}
        </span>
      )}

      <div className="pk-seat__top">
        <span
          className={`status-dot ${row?.connected ? "status-dot--online" : "status-dot--offline"}`}
          aria-label={row?.connected ? "connected" : "disconnected"}
        />
        <span className="pk-seat__name">{isOpen ? "Open" : seatLabel(seat)}</span>
        {isCurrentTurn && <span title="Current turn">🎯</span>}
      </div>

      {!isOpen && (
        <div className="pk-seat__badges">
          {row?.ready && <span className="ready-badge">Ready</span>}
          {hand?.natural && <span className="pk-badge bj-badge--blackjack">Blackjack</span>}
          {hand?.busted && <span className="pk-badge pk-badge--fold">Bust</span>}
          {hand?.doubled && <span className="pk-badge bj-badge--doubled">Doubled</span>}
          {row?.leavePending && <span className="pk-badge pk-badge--leaving">Leaving</span>}
        </div>
      )}

      {hand && (
        <>
          <div className="pk-reveal__cards bj-seat__cards">
            {hand.cards.map((c) => (
              <PokerCard key={c.id} card={c} />
            ))}
          </div>
          <div className="pk-seat__chips">
            <span className="pk-seat__total">{totalLabel(hand)}</span>
            <span>Bet {hand.bet.toLocaleString()}</span>
            {outcome && <span className={outcome === "lose" ? "" : "pk-seat__total"}>{OUTCOME_LABEL[outcome]}</span>}
          </div>
        </>
      )}

      {row && !isOpen && (
        <span className={`seat-credits ${row.credits < 0 ? "seat-credits--negative" : ""}`}>
          {formatCredits(row.credits)}
        </span>
      )}
    </div>
  );
}

function DealerArea({
  view,
  filledSeats,
  mySeat,
  seatLabel,
  skippedThisRound,
  reducedMotion,
}: {
  view: RedactedView | null;
  filledSeats: number;
  mySeat: Seat | null;
  seatLabel: (seat: Seat) => string;
  skippedThisRound: boolean;
  reducedMotion: boolean;
}) {
  if (!view) {
    return (
      <p className="table-center__hint">
        {filledSeats >= MIN_SEATS_TO_START
          ? "Ready up to deal the first round."
          : `Waiting for players (${filledSeats} seated, ${MIN_SEATS_TO_START}+ needed)…`}
      </p>
    );
  }

  return (
    <>
      <p className="pk-phase">Dealer</p>
      <DealerCards view={view} reducedMotion={reducedMotion} />
      {view.phase === "acting" ? (
        <>
          <p className="pk-currentbet">
            Dealer shows {view.dealerUpCard.rank === 14 ? 11 : Math.min(view.dealerUpCard.rank, 10)}
          </p>
          <p className="table-center__turn">
            {view.currentTurn === mySeat ? "Your move" : `Waiting on ${seatLabel(view.currentTurn)}`}
          </p>
          {skippedThisRound && (
            <p className="table-center__hint">You&rsquo;re sitting out this round — it&rsquo;ll deal you back in next time.</p>
          )}
        </>
      ) : (
        <p className="pk-finished-banner">
          {view.dealerBusted ? `Dealer busts (${view.dealerTotal})` : `Dealer stands on ${view.dealerTotal}`}
        </p>
      )}
    </>
  );
}

/**
 * The dealer's card row. While acting: the up card plus one face-down hole
 * card. On the acting -> finished transition, the hole card flips face-up and
 * any dealer draws flip in staggered after it — but only when this component
 * actually witnessed the acting phase: a mount straight into a finished view
 * (reconnect, spectator landing late) renders statically, mirroring
 * PokerTable's Board baseline convention.
 */
function DealerCards({ view, reducedMotion }: { view: RedactedView; reducedMotion: boolean }) {
  const sawActingRef = useRef(view.phase === "acting");
  useEffect(() => {
    if (view.phase === "acting") sawActingRef.current = true;
  }, [view.phase]);

  if (view.phase === "acting") {
    return (
      <div className="pk-board">
        <PokerCard card={view.dealerUpCard} />
        <div className="flip" aria-label="face-down card">
          <div className="flip__inner">
            <div className="flip__face flip__face--back" />
          </div>
        </div>
      </div>
    );
  }

  const animate = sawActingRef.current && !reducedMotion;
  return (
    <div className="pk-board">
      <PokerCard card={view.dealerCards[0]} />
      {view.dealerCards.slice(1).map((c, i) =>
        animate ? (
          <FlipInCard key={c.id} card={c} delayMs={i * 300} />
        ) : (
          <PokerCard key={c.id} card={c} />
        ),
      )}
    </div>
  );
}

/** A card that mounts face-down and flips face-up after `delayMs` — same
 * mechanics as PokerTable's FlipInCard (shared `.flip*` classes). */
function FlipInCard({ card, delayMs }: { card: Card; delayMs: number }) {
  const [revealed, setRevealed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setRevealed(true), 20 + delayMs);
    return () => clearTimeout(t);
  }, [delayMs]);

  return (
    <div className={`flip ${revealed ? "flip--revealed" : ""}`}>
      <div className="flip__inner">
        <div className="flip__face flip__face--back" aria-hidden="true" />
        <div className="flip__face flip__face--front">
          <PokerCard card={card} />
        </div>
      </div>
    </div>
  );
}

/** Non-blocking post-round panel with the dealer result, this seat's own
 * outcome, and the auto-deal countdown — the felt stays visible so the
 * per-seat delta chips can play underneath (mirrors poker's NextHandBanner). */
function NextRoundBanner({
  view,
  settled,
  mySeat,
  secondsLeft,
  onExit,
}: {
  view: Extract<RedactedView, { phase: "finished" }>;
  settled: SettledMessage;
  mySeat: Seat | null;
  secondsLeft: number;
  onExit: () => void;
}) {
  const myOutcome = mySeat !== null ? view.outcomes[mySeat] : undefined;
  const myDelta = mySeat !== null ? settled.deltas[mySeat] : undefined;
  const headline = view.dealerBusted ? `Dealer busts (${view.dealerTotal})` : `Dealer stands on ${view.dealerTotal}`;

  return (
    <div className="pk-nexthand" role="status">
      <p className="pk-nexthand__winner">{headline}</p>
      {myOutcome !== undefined && myDelta !== undefined && (
        <p className="pk-nexthand__timer">
          {OUTCOME_LABEL[myOutcome]}
          {myDelta !== 0 ? ` (${formatDelta(myDelta)})` : ""}
        </p>
      )}
      <p className="pk-nexthand__timer">
        {secondsLeft > 0 ? `Next round in ${secondsLeft}s` : "Dealing next round…"}
      </p>
      {settled.newBalance !== undefined && (
        <p className="pk-nexthand__balance">Your balance: {settled.newBalance.toLocaleString()}</p>
      )}
      <button type="button" className="button button--ghost" onClick={onExit}>
        Exit to lobby
      </button>
    </div>
  );
}
