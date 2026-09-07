import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import { getGuestToken } from "../api/client";
import type {
  ClientMessage,
  ErrorMessage,
  RedactedView,
  Seat,
  SeatStatus,
  ServerMessage,
  SettledMessage,
} from "./poker-types";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed" | "failed";

interface PokerSocketState {
  status: ConnectionStatus;
  handNo: number;
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
  error: ErrorMessage | null;
  settled: SettledMessage | null;
  /**
   * Every username ever seen for a seat, merged (never removed) as `state`
   * frames arrive. Needed because PokerTableDO frees a leaving/departed
   * seat's row (userId/username -> null) as part of the very same
   * settle-then-broadcast sequence that sends the 'settled' message for that
   * seat's own hand (see poker-table.ts's trySettle: broadcastSettled() runs
   * BEFORE the leavers are freed and broadcastState() re-sent) — so by the
   * time the settled panel renders, the live `seats` array may already show
   * that seat as empty. Falling back to this map keeps a departed winner's
   * name on their own settlement line instead of showing "Open".
   */
  usernames: Readonly<Record<Seat, string>>;
  /**
   * The epoch-ms target from the most recent 'nextHand' message (broadcast
   * right after 'settled' — see poker-protocol.ts's NextHandMessage doc
   * comment), or null before any hand has settled. Cleared by the exact same
   * signal `settled` itself clears on (handNo advancing on a fresh 'state'
   * frame), so the two always disappear together — PokerTable uses this only
   * to render a "next hand in Ns" countdown, never as a guarantee a hand
   * actually starts at this time (see the wire type's own doc comment).
   */
  nextHand: number | null;
}

type Action =
  | { kind: "status"; status: ConnectionStatus }
  | { kind: "server-message"; message: ServerMessage }
  | { kind: "dismiss-error" };

const initialState: PokerSocketState = {
  status: "connecting",
  handNo: 0,
  seats: null,
  view: null,
  error: null,
  settled: null,
  usernames: {},
  nextHand: null,
};

function reducer(state: PokerSocketState, action: Action): PokerSocketState {
  switch (action.kind) {
    case "status":
      return { ...state, status: action.status };
    case "dismiss-error":
      return { ...state, error: null };
    case "server-message": {
      const msg = action.message;
      switch (msg.type) {
        case "state": {
          const usernames = { ...state.usernames };
          for (const s of msg.seats) {
            if (s.username !== null) usernames[s.seat] = s.username;
          }
          // A settlement panel belongs to the hand it settled; a fresh hand
          // (ready-up -> deal) means it's done showing — mirrors doudizhu's/
          // liarsbar's round-keyed clearing rule, keyed on handNo here.
          const settled = state.settled && msg.handNo !== state.settled.handNo ? null : state.settled;
          // Same clearing rule as `settled` above, keyed on handNo actually
          // advancing (not on `view` — a skipped/disconnected-at-deal-time
          // seat's `view` can itself go null mid-hand, which must NOT be
          // mistaken for "the next hand arrived").
          const nextHand = msg.handNo !== state.handNo ? null : state.nextHand;
          return { ...state, handNo: msg.handNo, seats: msg.seats, view: msg.view, settled, nextHand, usernames };
        }
        case "error":
          return { ...state, error: msg };
        case "settled":
          return { ...state, settled: msg };
        case "nextHand":
          return { ...state, nextHand: msg.at };
        default:
          return state;
      }
    }
    default:
      return state;
  }
}

const BASE_RECONNECT_DELAY_MS = 500;
const MAX_RECONNECT_DELAY_MS = 8000;
/**
 * A connection attempt that closes without ever delivering a single server
 * frame is treated as a rejection, not a transient network blip — the DO
 * refuses the WebSocket upgrade outright (409) while a hand is mid-play or
 * the table is full (see poker-table.ts's fetch()), and that refusal looks
 * identical, from the browser's WebSocket API, to any other immediate close.
 * After this many such frame-less closes in a row, give up rather than
 * spinning a reconnect indicator forever — see `status: "failed"`. A close
 * that happens AFTER at least one frame arrived (we were genuinely seated)
 * always keeps retrying with backoff, no cap, exactly like the other games'
 * sockets — that's a real drop, not a rejected join attempt.
 */
const MAX_BLIND_ATTEMPTS = 3;

/**
 * Parallel counterpart to useGameSocket (doudizhu) / useLiarsBarSocket —
 * kept as its own hook rather than genericizing the shared shape, same
 * rationale as liarsbar's (see useLiarsBarSocket's doc comment): the
 * connection/reconnect plumbing is duplicated, but poker's own needs (no
 * 'aborted' message, the blind-attempt give-up gate below, the usernames
 * carry-forward map above) are specific enough that a shared hook would just
 * grow game-specific branches.
 */
export function usePokerSocket(tableId: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const blindAttemptsRef = useRef(0);
  const receivedFrameRef = useRef(false);
  const closedByClientRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [retryGeneration, setRetryGeneration] = useState(0);

  useEffect(() => {
    closedByClientRef.current = false;
    attemptRef.current = 0;
    blindAttemptsRef.current = 0;
    receivedFrameRef.current = false;

    function connect() {
      dispatch({ kind: "status", status: attemptRef.current === 0 ? "connecting" : "reconnecting" });

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const guestToken = getGuestToken();
      const url =
        `${proto}//${window.location.host}/api/tables/poker/${encodeURIComponent(tableId)}/ws` +
        (guestToken ? `?token=${encodeURIComponent(guestToken)}` : "");
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => {
        dispatch({ kind: "status", status: "open" });
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const parsed = JSON.parse(event.data) as ServerMessage;
          receivedFrameRef.current = true;
          blindAttemptsRef.current = 0;
          attemptRef.current = 0;
          dispatch({ kind: "server-message", message: parsed });
        } catch {
          // The server never sends non-JSON frames; ignore anything malformed.
        }
      };

      ws.onclose = () => {
        if (closedByClientRef.current) return;

        if (!receivedFrameRef.current) {
          blindAttemptsRef.current += 1;
          if (blindAttemptsRef.current >= MAX_BLIND_ATTEMPTS) {
            dispatch({ kind: "status", status: "failed" });
            return;
          }
        }

        dispatch({ kind: "status", status: "reconnecting" });
        const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attemptRef.current, MAX_RECONNECT_DELAY_MS);
        attemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      // A transport error is always followed by a close event; let onclose
      // own the reconnect/give-up decision so it isn't made twice.
      ws.onerror = () => {
        ws.close();
      };
    }

    connect();

    return () => {
      closedByClientRef.current = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
    };
  }, [tableId, retryGeneration]);

  const send = useCallback((message: ClientMessage) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  const dismissError = useCallback(() => dispatch({ kind: "dismiss-error" }), []);
  /** Manually re-arm a fresh connection attempt after "failed" — used by the busy/full panel's Retry button. */
  const retry = useCallback(() => setRetryGeneration((g) => g + 1), []);

  return useMemo(
    () => ({ ...state, send, dismissError, retry }),
    [state, send, dismissError, retry],
  );
}
