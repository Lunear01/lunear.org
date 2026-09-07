import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { STARTING_STACK_MULTIPLE } from "poker";
import { PokerCard, PokerCardSlot } from "../components/PokerCard";
import { useAuth } from "../context/AuthContext";
import type {
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
  const { status, seats, view, error, settled, usernames, send, dismissError, retry } = usePokerSocket(tableId);

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

  // Between hands: no hand has ever been dealt, or the last one reached a
  // terminal phase (showdown/fold-out) — exactly like doudizhu's/liarsbar's
  // `view === null || view.phase === "finished"` gate, extended with poker's
  // extra terminal phase ("showdown", finished only ever means a fold-out
  // here — see games/poker/src/game.ts's FinishedState doc comment).
  const canReadyUp = mySeat !== null && (view === null || view.phase === "showdown" || view.phase === "finished");

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
            <PkSeat key={seat} seat={seat} seats={seats} view={view} mySeat={mySeat} seatLabel={seatLabel} />
          ))}
        </div>

        <div className="pk-center">
          <CenterArea view={view} filledSeats={filledSeats} mySeat={mySeat} seatLabel={seatLabel} />
        </div>

        <div className="pk-seats-col">
          {ALL_SEATS.slice(4, 8).map((seat) => (
            <PkSeat key={seat} seat={seat} seats={seats} view={view} mySeat={mySeat} seatLabel={seatLabel} />
          ))}
        </div>
      </div>

      <div className="pk-self">
        {myHoleCards && (
          <div className="pk-self__cards">
            <PokerCard card={myHoleCards[0]} big />
            <PokerCard card={myHoleCards[1]} big />
          </div>
        )}
        {myBadge && <p className="pk-self__committed">Your total this hand: {myBadge.committed.toLocaleString()}</p>}

        <div className="table-actions pk-actionbar">
          {bettingView && myBettingStatus && bettingView.currentTurn === mySeat && (
            <ActionControls view={bettingView} myBadge={myBettingStatus} send={send} />
          )}

          {canReadyUp && !settled && (
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

      {settled && terminalView && (
        <SettledOverlay
          view={terminalView}
          settled={settled}
          seatLabel={seatLabel}
          amReady={amReady}
          onReady={() => send({ type: "ready" })}
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
}: {
  seat: Seat;
  seats: readonly SeatStatus[];
  view: RedactedView | null;
  mySeat: Seat | null;
  seatLabel: (seat: Seat) => string;
}) {
  const row = seats.find((s) => s.seat === seat);
  const badge = seatBadgeInfo(view, seat);
  const isDealer = view?.dealerSeat === seat;
  const isMe = seat === mySeat;
  const isCurrentTurn = view !== null && "currentTurn" in view && view.currentTurn === seat;
  const isOpen = !row || row.userId === null;

  const classes = [
    "pk-seat",
    isMe && "pk-seat--me",
    isOpen && "pk-seat--open",
    badge?.folded && "pk-seat--folded",
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <div className={classes}>
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
}: {
  view: RedactedView | null;
  filledSeats: number;
  mySeat: Seat | null;
  seatLabel: (seat: Seat) => string;
}) {
  if (!view) {
    return (
      <p className="table-center__hint">
        Waiting for players ({filledSeats} seated, {MIN_SEATS_TO_START}+ needed)&hellip;
      </p>
    );
  }

  const community = view.community;
  const slots = Array.from({ length: 5 }).map((_, i) =>
    i < community.length ? <PokerCard key={i} card={community[i]} /> : <PokerCardSlot key={i} />,
  );

  return (
    <>
      <p className="pk-phase">{PHASE_LABEL[view.phase]}</p>
      <div className="pk-board">{slots}</div>
      <p className="pk-pot">Pot: {view.pot.toLocaleString()}</p>

      {(view.phase === "preflop" || view.phase === "flop" || view.phase === "turn" || view.phase === "river") && (
        <>
          {view.currentBet > 0 && <p className="pk-currentbet">Current bet: {view.currentBet.toLocaleString()}</p>}
          <p className="table-center__turn">
            {view.currentTurn === mySeat ? "Your turn" : `Waiting on ${seatLabel(view.currentTurn)}`}
          </p>
        </>
      )}

      {view.phase === "showdown" && <ShowdownReveals view={view.reveals} winners={view.winners} amountWon={view.amountWon} pot={view.pot} seatLabel={seatLabel} />}

      {view.phase === "finished" && (
        <p className="pk-finished-banner">
          {seatLabel(view.winner)} takes the pot ({view.pot.toLocaleString()})
        </p>
      )}
    </>
  );
}

function ShowdownReveals({
  view,
  winners,
  amountWon,
  pot,
  seatLabel,
}: {
  view: readonly ShowdownReveal[];
  winners: readonly Seat[];
  amountWon: Readonly<Record<Seat, number>>;
  pot: number;
  seatLabel: (seat: Seat) => string;
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
        {view.map((r) => {
          const isWinner = winners.includes(r.seat);
          return (
            <div key={r.seat} className={`pk-reveal ${isWinner ? "pk-reveal--winner" : ""}`}>
              <span className="pk-reveal__name">
                {seatLabel(r.seat)}
                {isWinner ? " 🏆" : ""}
              </span>
              <div className="pk-reveal__cards">
                <PokerCard card={r.holeCards[0]} />
                <PokerCard card={r.holeCards[1]} />
              </div>
              <span className="pk-reveal__hand">{formatHandName(r.hand)}</span>
              {amountWon[r.seat] > 0 && <span className="pk-reveal__won">+{amountWon[r.seat].toLocaleString()}</span>}
            </div>
          );
        })}
      </div>
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

function SettledOverlay({
  view,
  settled,
  seatLabel,
  amReady,
  onReady,
  onExit,
}: {
  view: Extract<RedactedView, { phase: "showdown" | "finished" }>;
  settled: { deltas: Readonly<Record<Seat, number>>; newBalance?: number };
  seatLabel: (seat: Seat) => string;
  amReady: boolean;
  onReady: () => void;
  onExit: () => void;
}) {
  const headline =
    view.phase === "finished"
      ? `${seatLabel(view.winner)} takes the pot`
      : view.winners.length === 1
        ? `${seatLabel(view.winners[0])} wins the pot`
        : `${view.winners.map(seatLabel).join(" & ")} split the pot`;

  const seatsInHand = (Object.keys(settled.deltas) as unknown as string[]).map(Number).sort((a, b) => a - b);

  return (
    <div className="settled-overlay">
      <div className="settled-card card">
        <h2 className="modal__title settled-card__winner settled-card__winner--gold">{headline}</h2>
        <ul>
          {seatsInHand.map((seat) => (
            <li key={seat}>
              {seatLabel(seat)}: {formatDelta(settled.deltas[seat])}
            </li>
          ))}
        </ul>
        {settled.newBalance !== undefined && (
          <p className="modal__hint">Your new balance: {settled.newBalance.toLocaleString()} credits</p>
        )}
        <div className="settled-card__actions">
          <button type="button" className="button button--primary" disabled={amReady} onClick={onReady}>
            {amReady ? "Waiting for others…" : "Ready for next hand"}
          </button>
          <button type="button" className="button" onClick={onExit}>
            Exit to lobby
          </button>
        </div>
      </div>
    </div>
  );
}
