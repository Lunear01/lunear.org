import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { STARTING_STACK_MULTIPLE } from "poker";
import { PokerCard, PokerCardSlot } from "../components/PokerCard";
import { useAuth } from "../context/AuthContext";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import type {
  Card,
  ClientMessage,
  ErrorCode,
  ErrorMessage,
  HandCategory,
  PublicBettingStatus,
  PublicTerminalStatus,
  RedactedBettingView,
  RedactedView,
  Seat,
  SeatStatus,
  SettledMessage,
  ShowdownReveal,
} from "../ws/poker-types";
import { usePokerSocket } from "../ws/usePokerSocket";

// This table page is poker-specific, so the lobby it returns to on exit is
// hardcoded rather than derived (mirrors Table.tsx's DOUDIZHU_LOBBY_PATH and
// LiarsBarTable.tsx's LIARSBAR_LOBBY_PATH).
const POKER_LOBBY_PATH = "/lobby/poker";

const ALL_SEATS: readonly Seat[] = [0, 1, 2, 3, 4, 5, 6, 7];
const MIN_SEATS_TO_START = 2;

const PHASE_LABEL: Record<RedactedView["phase"], string> = {
  preflop: "Pre-flop",
  flop: "Flop",
  turn: "Turn",
  river: "River",
  showdown: "Showdown",
  finished: "Hand over",
};

const FRIENDLY_ERROR: Record<ErrorCode, string> = {
  "bad-message": "Something went wrong sending that action.",
  "game-in-progress": "A hand is already in progress.",
  "no-active-hand": "There's no hand in progress right now.",
  "wrong-phase": "That action isn't allowed right now.",
  "not-your-turn": "It's not your turn yet.",
  "cannot-check": "You can't check — there's a bet to call.",
  "bet-too-small": "That bet is too small.",
  "raise-too-small": "That raise is too small.",
  "insufficient-stack": "You don't have enough chips for that.",
  "folded-player-action": "You've already folded this hand.",
  "invalid-amount": "That amount isn't valid.",
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

/**
 * The DO's auto-deal alarm fires ~`NEXT_HAND_COUNTDOWN_MS` after 'settled'
 * (see poker-protocol.ts's NextHandMessage doc comment), but only actually
 * deals if >=2 occupants are still connected at fire time — otherwise it
 * falls back to manual ready-up without ever sending a fresh 'state' frame,
 * which would otherwise leave the countdown banner stuck at "0s" forever.
 * This grace window, measured past the target `at` timestamp, is how long
 * the client waits for that fresh hand before giving up and reverting to the
 * ordinary manual Ready button — comfortably longer than any realistic
 * network/DO-alarm scheduling jitter for a ~6s countdown.
 */
const NEXT_HAND_GRACE_MS = 4000;

/** Prefers the live seats row, falling back to the socket hook's carry-forward
 * usernames map for a seat that's since been freed (see usePokerSocket's doc
 * comment on why that map exists — a settled/showdown line for a departed
 * player must still show their name, not "Open"). */
function makeSeatLabel(seats: readonly SeatStatus[] | null, usernames: Readonly<Record<Seat, string>>) {
  return (seat: Seat): string => {
    return seats?.find((s) => s.seat === seat)?.username ?? usernames[seat] ?? `Seat ${seat}`;
  };
}

// --- Hand-name formatting ----------------------------------------------------

const RANK_SINGULAR: Record<number, string> = {
  2: "two",
  3: "three",
  4: "four",
  5: "five",
  6: "six",
  7: "seven",
  8: "eight",
  9: "nine",
  10: "ten",
  11: "jack",
  12: "queen",
  13: "king",
  14: "ace",
};

const RANK_PLURAL: Record<number, string> = {
  2: "twos",
  3: "threes",
  4: "fours",
  5: "fives",
  6: "sixes",
  7: "sevens",
  8: "eights",
  9: "nines",
  10: "tens",
  11: "jacks",
  12: "queens",
  13: "kings",
  14: "aces",
};

/** Formats every HandCategory the evaluator can produce — see
 * games/poker/src/evaluator.ts's HandResult doc comment for the exact
 * per-category `ranks` layout this reads from. */
function formatHandName(hand: { category: HandCategory; ranks: readonly number[] }): string {
  const [r0, r1] = hand.ranks;
  switch (hand.category) {
    case "high-card":
      return `High card — ${RANK_SINGULAR[r0]} high`;
    case "pair":
      return `Pair of ${RANK_PLURAL[r0]}`;
    case "two-pair":
      return `Two pair — ${RANK_PLURAL[r0]} and ${RANK_PLURAL[r1]}`;
    case "trips":
      return `Three of a kind — ${RANK_PLURAL[r0]}`;
    case "straight":
      return `Straight — ${RANK_SINGULAR[r0]} high`;
    case "flush":
      return `Flush — ${RANK_SINGULAR[r0]} high`;
    case "full-house":
      return `Full house — ${RANK_PLURAL[r0]} over ${RANK_PLURAL[r1]}`;
    case "quads":
      return `Four of a kind — ${RANK_PLURAL[r0]}`;
    case "straight-flush":
      return `Straight flush — ${RANK_SINGULAR[r0]} high`;
  }
}

// --- Per-seat status extraction ----------------------------------------------

interface SeatBadgeInfo {
  readonly folded: boolean;
  readonly allIn: boolean;
  readonly committed: number;
  /** Null once the hand's reached showdown/finished — those views only expose `committed`. */
  readonly streetCommitted: number | null;
}

function isBettingStatus(p: PublicBettingStatus | PublicTerminalStatus): p is PublicBettingStatus {
  return "streetCommitted" in p;
}

function seatBadgeInfo(view: RedactedView | null, seat: Seat): SeatBadgeInfo | null {
  if (!view) return null;
  const p = view.players[seat];
  if (!p) return null;
  if (isBettingStatus(p)) {
    return { folded: p.folded, allIn: p.allIn, committed: p.committed, streetCommitted: p.streetCommitted };
  }
  return { folded: p.folded, allIn: false, committed: p.committed, streetCommitted: null };
}

/** Type guard narrowing the 3-way RedactedView union down to the live-betting
 * variant (preflop/flop/turn/river) — used wherever code needs `currentTurn`/
 * `holeCards`/`currentBet`, which only that variant carries. Plain `!==`
 * comparisons through optional chaining (`view?.phase !== "x"`) do NOT narrow
 * `view` itself in TypeScript, only the chained expression's own type — this
 * predicate is what actually lets the compiler follow the narrowing through. */
function isBettingView(view: RedactedView): view is RedactedBettingView {
  return view.phase !== "showdown" && view.phase !== "finished";
}

export default function PokerTable() {
  const { tableId = "" } = useParams<{ tableId: string }>();
  const navigate = useNavigate();
  const { user, refresh } = useAuth();
  const { status, handNo, seats, view, error, settled, nextHand, usernames, send, dismissError, retry } =
    usePokerSocket(tableId);
  const reducedMotion = usePrefersReducedMotion();

  // Ticks while a "next hand in Ns" countdown is live so the banner's timer
  // text stays current — otherwise this component would only re-render off
  // real WS traffic and the countdown would appear frozen between frames.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (nextHand === null) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [nextHand]);

  const countdownMsLeft = nextHand !== null ? nextHand - now : null;
  // True from the moment 'nextHand' arrives until either the fresh hand's
  // 'state' frame clears it (the common case) or NEXT_HAND_GRACE_MS passes
  // the target time with no fresh hand showing up (the DO fell back to
  // manual ready-up — see NEXT_HAND_GRACE_MS's doc comment above).
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

  // A seated occupant who was disconnected at deal time is dealt out of that
  // one hand entirely — their own `view` is null for its whole betting-street
  // duration, only reappearing once it reaches showdown/finished (see
  // poker-table.ts's viewForSeatOrSpectator doc comment). That's
  // indistinguishable from "no hand has ever started" by `view` alone, since
  // both are `view === null` — but `handNo` only ever advances once a hand
  // has actually been dealt, so `view === null && handNo > 0` uniquely means
  // "skipped, mid-hand" rather than "table hasn't started yet".
  const skippedThisHand = mySeat !== null && view === null && handNo > 0;

  // Between hands: no hand has ever been dealt, or the last one reached a
  // terminal phase (showdown/fold-out) — exactly like doudizhu's/liarsbar's
  // `view === null || view.phase === "finished"` gate, extended with poker's
  // extra terminal phase ("showdown", finished only ever means a fold-out
  // here — see games/poker/src/game.ts's FinishedState doc comment). Excludes
  // a skipped-this-hand seat (above) and the countdown window (the server
  // no-ops a ready during it anyway — see NextHandBanner/countdownActive).
  const canReadyUp =
    mySeat !== null &&
    !skippedThisHand &&
    !countdownActive &&
    (view === null || view.phase === "showdown" || view.phase === "finished");

  const handleLeaveTable = () => {
    send({ type: "leave" });
    navigate("/");
  };
  const handleExitToLobby = () => navigate(POKER_LOBBY_PATH);

  if (status === "failed") {
    return (
      <div className="page">
        <div className="card page-loading">
          <h1 className="page__title">Table is busy or full</h1>
          <p>This table couldn&rsquo;t be joined right now — it may be mid-hand or already at capacity.</p>
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

  const bettingView = view !== null && isBettingView(view) ? view : null;
  const terminalView = view !== null && !isBettingView(view) ? view : null;
  const myBadge = mySeat !== null ? seatBadgeInfo(view, mySeat) : null;
  const myHoleCards = bettingView?.holeCards ?? null;
  const myBettingStatus: PublicBettingStatus | null =
    bettingView && mySeat !== null ? bettingView.players[mySeat] : null;

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

      <div className="pk-felt">
        <div className="pk-seats-col">
          {ALL_SEATS.slice(0, 4).map((seat) => (
            <PkSeat
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

        <div className="pk-center">
          <CenterArea
            view={view}
            filledSeats={filledSeats}
            mySeat={mySeat}
            seatLabel={seatLabel}
            skippedThisHand={skippedThisHand}
            settling={settled !== null && countdownActive}
            reducedMotion={reducedMotion}
          />
        </div>

        <div className="pk-seats-col">
          {ALL_SEATS.slice(4, 8).map((seat) => (
            <PkSeat
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
        {myHoleCards && (
          <div className="pk-self__cards" key={myHoleCards.map((c) => c.id).join(",")}>
            <PokerCard card={myHoleCards[0]} big />
            <PokerCard card={myHoleCards[1]} big />
          </div>
        )}
        {myBadge && <p className="pk-self__committed">Your total this hand: {myBadge.committed.toLocaleString()}</p>}
        {mySeatRow && (
          <p className={`pk-self__credits ${mySeatRow.credits < 0 ? "pk-self__credits--negative" : ""}`}>
            Your credits: {formatCredits(mySeatRow.credits)}
          </p>
        )}

        <div className="table-actions pk-actionbar">
          {bettingView && myBettingStatus && bettingView.currentTurn === mySeat && (
            <ActionControls view={bettingView} myBadge={myBettingStatus} send={send} />
          )}

          {canReadyUp && (
            <button
              type="button"
              className="button button--primary"
              disabled={amReady}
              onClick={() => send({ type: "ready" })}
            >
              {amReady ? "Waiting for others…" : view === null ? "Ready" : "Ready for next hand"}
            </button>
          )}
        </div>
      </div>

      {settled && countdownActive && terminalView && (
        <NextHandBanner
          view={terminalView}
          settled={settled}
          seatLabel={seatLabel}
          secondsLeft={countdownSeconds}
          onExit={handleExitToLobby}
        />
      )}
    </div>
  );
}

function PkSeat({
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
  /** Null outside the post-hand results phase — see PokerTable's own `settled`. */
  settled: SettledMessage | null;
  /** True only while the auto-deal countdown banner is actually showing — see PokerTable's own `countdownActive`. */
  countdownActive: boolean;
}) {
  const row = seats.find((s) => s.seat === seat);
  const badge = seatBadgeInfo(view, seat);
  const isDealer = view?.dealerSeat === seat;
  const isMe = seat === mySeat;
  const isCurrentTurn = view !== null && "currentTurn" in view && view.currentTurn === seat;
  const isOpen = !row || row.userId === null;

  // Floating delta chip + winner glow, both scoped to the transient results
  // phase (settled result still showing AND the auto-proceed countdown still
  // running) and both keyed on `settled.handNo` so a fresh settlement always
  // remounts (and thus replays) the chip's one-shot rise/sink animation.
  // Optional-chained reads (rather than an early `settled !== null` guard)
  // deliberately avoid a variable TypeScript can't narrow through below.
  const seatDelta = settled?.deltas[seat];
  const showResult = countdownActive && seatDelta !== undefined;
  const delta = seatDelta ?? 0;
  const isWinnerSeat = showResult && delta > 0;

  const classes = [
    "pk-seat",
    isMe && "pk-seat--me",
    isOpen && "pk-seat--open",
    badge?.folded && "pk-seat--folded",
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
        {isDealer && (
          <span className="pk-dealer-btn" aria-label="dealer">
            D
          </span>
        )}
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
          {badge?.folded && <span className="pk-badge pk-badge--fold">Folded</span>}
          {badge?.allIn && <span className="pk-badge pk-badge--allin">All-in</span>}
          {row?.leavePending && <span className="pk-badge pk-badge--leaving">Leaving</span>}
        </div>
      )}

      {row && !isOpen && (
        <span className={`seat-credits ${row.credits < 0 ? "seat-credits--negative" : ""}`}>
          {formatCredits(row.credits)}
        </span>
      )}

      {badge && (
        <div className="pk-seat__chips">
          {badge.streetCommitted !== null && badge.streetCommitted > 0 && <span>Bet {badge.streetCommitted.toLocaleString()}</span>}
          <span className="pk-seat__total">Total {badge.committed.toLocaleString()}</span>
        </div>
      )}
    </div>
  );
}

function CenterArea({
  view,
  filledSeats,
  mySeat,
  seatLabel,
  skippedThisHand,
  settling,
  reducedMotion,
}: {
  view: RedactedView | null;
  filledSeats: number;
  mySeat: Seat | null;
  seatLabel: (seat: Seat) => string;
  /** True when this seat is dealt out of the CURRENT hand (see PokerTable's
   * own `skippedThisHand` doc comment) — `view` is null either way, so this
   * distinguishes "sitting out a hand in progress" from "no hand yet". */
  skippedThisHand: boolean;
  /** True during the post-settlement auto-proceed countdown — pulses the pot
   * once as a lightweight "sweeping toward the winner" cue. */
  settling: boolean;
  reducedMotion: boolean;
}) {
  if (!view) {
    if (skippedThisHand) {
      return <p className="table-center__hint">You&rsquo;re sitting out this hand — it&rsquo;ll deal you back in next time.</p>;
    }
    return (
      <p className="table-center__hint">
        Waiting for players ({filledSeats} seated, {MIN_SEATS_TO_START}+ needed)&hellip;
      </p>
    );
  }

  const community = view.community;

  return (
    <>
      <p className="pk-phase">{PHASE_LABEL[view.phase]}</p>
      <Board community={community} reducedMotion={reducedMotion} />
      <p className={`pk-pot ${settling ? "pk-pot--settling" : ""}`}>Pot: {view.pot.toLocaleString()}</p>

      {(view.phase === "preflop" || view.phase === "flop" || view.phase === "turn" || view.phase === "river") && (
        <>
          {view.currentBet > 0 && <p className="pk-currentbet">Current bet: {view.currentBet.toLocaleString()}</p>}
          <p className="table-center__turn">
            {view.currentTurn === mySeat ? "Your turn" : `Waiting on ${seatLabel(view.currentTurn)}`}
          </p>
        </>
      )}

      {view.phase === "showdown" && (
        <ShowdownReveals
          view={view.reveals}
          winners={view.winners}
          amountWon={view.amountWon}
          pot={view.pot}
          seatLabel={seatLabel}
          reducedMotion={reducedMotion}
        />
      )}

      {view.phase === "finished" && (
        <p className="pk-finished-banner">
          {seatLabel(view.winner)} takes the pot ({view.pot.toLocaleString()})
        </p>
      )}
    </>
  );
}

/**
 * Community-card row. Flips in each newly-dealt card (flop's 3 staggered
 * ~250ms apart, turn/river a single flip) by comparing the board's length
 * against the length last seen. `prevLenRef` starts at `null` so the very
 * first render — whatever the board already looks like, whether a fresh
 * table's empty preflop or a reconnect landing mid-hand with cards already
 * out — is never treated as "growth" and never animates; only a length
 * increase seen *after* that first render (i.e. a card genuinely appearing
 * while this component stayed mounted) counts as new.
 */
function Board({ community, reducedMotion }: { community: readonly Card[]; reducedMotion: boolean }) {
  const prevLenRef = useRef<number | null>(null);
  const [newFromIndex, setNewFromIndex] = useState<number | null>(null);

  useEffect(() => {
    const prevLen = prevLenRef.current;
    if (prevLen === null) {
      // First render this component has ever seen — establish the baseline,
      // don't animate whatever's already showing.
      setNewFromIndex(null);
    } else if (community.length > prevLen) {
      setNewFromIndex(prevLen);
    } else if (community.length < prevLen) {
      // A new hand's board reset back to empty — nothing to animate.
      setNewFromIndex(null);
    }
    prevLenRef.current = community.length;
  }, [community.length]);

  const slots = Array.from({ length: 5 }).map((_, i) => {
    if (i >= community.length) return <PokerCardSlot key={i} />;
    const isNew = !reducedMotion && newFromIndex !== null && i >= newFromIndex;
    if (!isNew) return <PokerCard key={i} card={community[i]} />;
    return <FlipInCard key={i} card={community[i]} delayMs={(i - newFromIndex!) * 250} />;
  });

  return <div className="pk-board">{slots}</div>;
}

/** A card that mounts face-down and flips face-up after `delayMs` — shared
 * flip mechanics with LiarsBar's reveal overlay (see the `.flip*` classes in
 * global.css, a generic sibling of that screen's own `.lb-flip*`, added
 * rather than touching its working code). */
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

function ShowdownReveals({
  view,
  winners,
  amountWon,
  pot,
  seatLabel,
  reducedMotion,
}: {
  view: readonly ShowdownReveal[];
  winners: readonly Seat[];
  amountWon: Readonly<Record<Seat, number>>;
  pot: number;
  seatLabel: (seat: Seat) => string;
  reducedMotion: boolean;
}) {
  const winnerNames = winners.map(seatLabel);
  const title =
    winnerNames.length === 1
      ? `${winnerNames[0]} wins ${pot.toLocaleString()}`
      : `${winnerNames.join(" & ")} split the pot (${pot.toLocaleString()})`;

  return (
    <div className="pk-showdown">
      <p className="pk-showdown__title">{title}</p>
      <div className="pk-showdown__list">
        {view.map((r, i) => (
          <ShowdownRow
            key={r.seat}
            reveal={r}
            index={i}
            isWinner={winners.includes(r.seat)}
            amountWon={amountWon[r.seat] ?? 0}
            seatLabel={seatLabel}
            reducedMotion={reducedMotion}
          />
        ))}
      </div>
    </div>
  );
}

/**
 * One showdown seat's row: both hole cards flip face-up together, staggered
 * by `index` (seat order) ~300ms apart from the previous row, then — once
 * that flip has visually finished — the hand-name label (and winner
 * highlight/trophy/amount, if this seat won) fades in. `revealed`/`labelShown`
 * are local state driven by mount-time `setTimeout`s rather than props so
 * each row schedules its own reveal independent of re-renders elsewhere on
 * the page (e.g. the countdown ticking in the parent every 250ms).
 */
function ShowdownRow({
  reveal,
  index,
  isWinner,
  amountWon,
  seatLabel,
  reducedMotion,
}: {
  reveal: ShowdownReveal;
  index: number;
  isWinner: boolean;
  amountWon: number;
  seatLabel: (seat: Seat) => string;
  reducedMotion: boolean;
}) {
  // Initialized straight to their end state under reduced motion (rather
  // than relying on an almost-immediate setTimeout(0)) so there's no single
  // frame of face-down flash before the effect below fires.
  const [revealed, setRevealed] = useState(reducedMotion);
  const [labelShown, setLabelShown] = useState(reducedMotion);

  useEffect(() => {
    if (reducedMotion) return;
    const flipDelay = index * 300;
    const t1 = setTimeout(() => setRevealed(true), flipDelay);
    // ~500ms is the flip transition's own duration (see .flip__inner in
    // global.css) — the label waits for it to actually finish rather than
    // appearing mid-rotation.
    const t2 = setTimeout(() => setLabelShown(true), flipDelay + 500);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [index, reducedMotion]);

  const showWinner = isWinner && labelShown;

  return (
    <div className={`pk-reveal ${showWinner ? "pk-reveal--winner" : ""}`}>
      <span className="pk-reveal__name">
        {seatLabel(reveal.seat)}
        {showWinner ? " 🏆" : ""}
      </span>
      <div className="pk-reveal__cards">
        <div className={`flip ${revealed ? "flip--revealed" : ""}`}>
          <div className="flip__inner">
            <div className="flip__face flip__face--back" aria-hidden="true" />
            <div className="flip__face flip__face--front">
              <PokerCard card={reveal.holeCards[0]} />
            </div>
          </div>
        </div>
        <div className={`flip ${revealed ? "flip--revealed" : ""}`}>
          <div className="flip__inner">
            <div className="flip__face flip__face--back" aria-hidden="true" />
            <div className="flip__face flip__face--front">
              <PokerCard card={reveal.holeCards[1]} />
            </div>
          </div>
        </div>
      </div>
      <span className={`pk-reveal__hand ${labelShown ? "" : "pk-reveal__hand--pending"}`}>
        {formatHandName(reveal.hand)}
      </span>
      {showWinner && amountWon > 0 && <span className="pk-reveal__won">+{amountWon.toLocaleString()}</span>}
    </div>
  );
}

function ActionControls({
  view,
  myBadge,
  send,
}: {
  view: RedactedBettingView;
  myBadge: PublicBettingStatus;
  send: (message: ClientMessage) => void;
}) {
  const [amount, setAmount] = useState("");

  const checkLegal = myBadge.streetCommitted === view.currentBet;
  const callAmount = view.currentBet - myBadge.streetCommitted;
  const canBet = view.currentBet === 0;
  // The redacted view never exposes minRaiseIncrement/`restricted` (see
  // poker-types.ts / games/poker/src/game.ts's BettingState) — a real raise's
  // legal minimum can be larger than `stake` (it grows with prior full
  // raises this street), and a short-all-in-raised seat may be barred from
  // raising at all regardless of amount. The quick "Min" amount below is
  // therefore only an approximation (currentBet + stake); an under-minimum
  // or restricted attempt is rejected server-side and surfaced as a friendly
  // "raise-too-small" toast, per this screen's explicit client/server split.
  const remainingStack = STARTING_STACK_MULTIPLE * view.stake - myBadge.committed;

  const quickAmounts = canBet
    ? [
        { label: "Min", value: view.stake },
        { label: "½ pot", value: Math.max(view.stake, Math.round(view.pot / 2)) },
        { label: "Pot", value: Math.max(view.stake, view.pot) },
        { label: "All-in", value: remainingStack },
      ]
    : [
        { label: "Min", value: view.currentBet + view.stake },
        { label: "½ pot", value: view.currentBet + Math.round(view.pot / 2) },
        { label: "Pot", value: view.currentBet + view.pot },
        { label: "All-in", value: view.currentBet + remainingStack },
      ];

  function applyQuick(value: number) {
    const cap = canBet ? remainingStack : view.currentBet + remainingStack;
    setAmount(String(Math.max(1, Math.min(value, cap))));
  }

  function submit() {
    const n = Math.floor(Number(amount));
    if (!Number.isFinite(n) || n <= 0) return;
    if (canBet) send({ type: "bet", amount: n });
    else send({ type: "raise", toAmount: n });
    setAmount("");
  }

  return (
    <>
      <button type="button" className="button button--danger" onClick={() => send({ type: "fold" })}>
        Fold
      </button>
      {checkLegal ? (
        <button type="button" className="button" onClick={() => send({ type: "check" })}>
          Check
        </button>
      ) : (
        <button type="button" className="button" disabled={callAmount <= 0} onClick={() => send({ type: "call" })}>
          Call {callAmount.toLocaleString()}
        </button>
      )}
      <div className="pk-raise">
        <div className="pk-raise__quick">
          {quickAmounts.map((q) => (
            <button key={q.label} type="button" className="button button--small" onClick={() => applyQuick(q.value)}>
              {q.label}
            </button>
          ))}
        </div>
        <input
          type="number"
          className="field__input pk-raise__input"
          inputMode="numeric"
          min={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder={canBet ? "Bet amount" : "Raise to"}
        />
        <button type="button" className="button button--primary" disabled={!amount} onClick={submit}>
          {canBet ? "Bet" : "Raise"}
        </button>
      </div>
    </>
  );
}

/**
 * Replaces the old click-to-continue settlement modal: a small non-blocking
 * panel (the felt/seats stay visible underneath, so the per-seat delta chips
 * and pot pulse are actually visible while this shows) with the winner and a
 * live "next hand in Ns" countdown — no Ready button here, since a manual
 * ready is a no-op during the countdown anyway (PokerTable hides/disables its
 * own Ready button for the same reason). Per-seat deltas aren't repeated here
 * as a list; PkSeat's floating chips already show them at their source.
 */
function NextHandBanner({
  view,
  settled,
  seatLabel,
  secondsLeft,
  onExit,
}: {
  view: Extract<RedactedView, { phase: "showdown" | "finished" }>;
  settled: { newBalance?: number };
  seatLabel: (seat: Seat) => string;
  secondsLeft: number;
  onExit: () => void;
}) {
  const headline =
    view.phase === "finished"
      ? `${seatLabel(view.winner)} takes the pot`
      : view.winners.length === 1
        ? `${seatLabel(view.winners[0])} wins the pot`
        : `${view.winners.map(seatLabel).join(" & ")} split the pot`;

  return (
    <div className="pk-nexthand" role="status">
      <p className="pk-nexthand__winner">{headline}</p>
      <p className="pk-nexthand__timer">
        {secondsLeft > 0 ? `Next hand in ${secondsLeft}s` : "Dealing next hand…"}
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
