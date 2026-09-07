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
} from "./blackjack-types";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed" | "failed";

interface BlackjackSocketState {
  status: ConnectionStatus;
  handNo: number;
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
  error: ErrorMessage | null;
  settled: SettledMessage | null;
  /** Every username ever seen for a seat, merged as `state` frames arrive —
   * same carry-forward map as usePokerSocket, and for the same reason: a
   * departed seat's row is freed before the settlement panel renders. */
  usernames: Readonly<Record<Seat, string>>;
  /** Auto-deal countdown target from the latest 'nextHand' message, or null —
   * cleared when handNo advances, together with `settled`. */
  nextHand: number | null;
}

type Action =
  | { kind: "status"; status: ConnectionStatus }
  | { kind: "server-message"; message: ServerMessage }
  | { kind: "dismiss-error" };

const initialState: BlackjackSocketState = {
  status: "connecting",
  handNo: 0,
  seats: null,
  view: null,
  error: null,
  settled: null,
  usernames: {},
  nextHand: null,
};

function reducer(state: BlackjackSocketState, action: Action): BlackjackSocketState {
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
          // A settlement panel belongs to the round it settled; a fresh deal
          // means it's done showing — keyed on handNo, like the other games.
          const settled = state.settled && msg.handNo !== state.settled.handNo ? null : state.settled;
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
/** Give-up gate for frame-less closes (a 409 refusal mid-round / full table)
 * — see usePokerSocket's MAX_BLIND_ATTEMPTS for the full rationale. */
const MAX_BLIND_ATTEMPTS = 3;

/**
 * Parallel counterpart to usePokerSocket, kept as its own hook rather than
 * genericizing the shared connection plumbing — same rationale as the other
 * per-game sockets: the message unions and give-up semantics are per-game.
 */
export function useBlackjackSocket(tableId: string) {
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
        `${proto}//${window.location.host}/api/tables/blackjack/${encodeURIComponent(tableId)}/ws` +
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
