import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { getGuestToken } from "../api/client";
import type {
  AbortedMessage,
  ClientMessage,
  ErrorMessage,
  RedactedView,
  SeatStatus,
  ServerMessage,
  SettledMessage,
} from "./uno-types";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

interface GameSocketState {
  status: ConnectionStatus;
  round: number;
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
  error: ErrorMessage | null;
  settled: SettledMessage | null;
  /** Set once the hand is voided by a leave or a disconnect-grace expiry; an aborted table never resumes. */
  aborted: AbortedMessage | null;
}

type Action =
  | { kind: "status"; status: ConnectionStatus }
  | { kind: "server-message"; message: ServerMessage }
  | { kind: "dismiss-error" };

const initialState: GameSocketState = {
  status: "connecting",
  round: 0,
  seats: null,
  view: null,
  error: null,
  settled: null,
  aborted: null,
};

function reducer(state: GameSocketState, action: Action): GameSocketState {
  switch (action.kind) {
    case "status":
      return { ...state, status: action.status };
    case "dismiss-error":
      return { ...state, error: null };
    case "server-message": {
      const msg = action.message;
      switch (msg.type) {
        case "state": {
          // A settlement overlay belongs to the round it settled.
          const settled = state.settled && msg.round !== state.settled.round ? null : state.settled;
          return { ...state, round: msg.round, seats: msg.seats, view: msg.view, settled };
        }
        case "error":
          return { ...state, error: msg };
        case "aborted":
          return { ...state, aborted: msg };
        case "settled":
          return { ...state, settled: msg };
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
 * Owns the single WebSocket for an UNO table (GET /api/tables/uno/:tableId/ws).
 * Copy of doudizhu's useGameSocket pointed at the uno protocol types: same
 * cookie/guest-token auth, same exponential-backoff reconnect while mounted.
 */
export function useUnoSocket(tableId: string) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const socketRef = useRef<WebSocket | null>(null);
  const attemptRef = useRef(0);
  const closedByClientRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    closedByClientRef.current = false;
    attemptRef.current = 0;

    function connect() {
      dispatch({ kind: "status", status: attemptRef.current === 0 ? "connecting" : "reconnecting" });

      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      const guestToken = getGuestToken();
      const url =
        `${proto}//${window.location.host}/api/tables/uno/${encodeURIComponent(tableId)}/ws` +
        (guestToken ? `?token=${encodeURIComponent(guestToken)}` : "");
      const ws = new WebSocket(url);
      socketRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        dispatch({ kind: "status", status: "open" });
      };

      ws.onmessage = (event) => {
        if (typeof event.data !== "string") return;
        try {
          const parsed = JSON.parse(event.data) as ServerMessage;
          dispatch({ kind: "server-message", message: parsed });
        } catch {
          // The server never sends non-JSON frames; ignore anything malformed.
        }
      };

      ws.onclose = () => {
        if (closedByClientRef.current) return;
        dispatch({ kind: "status", status: "reconnecting" });
        const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attemptRef.current, MAX_RECONNECT_DELAY_MS);
        attemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      // A transport error is always followed by a close event; onclose owns the reconnect.
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
  }, [tableId]);

  const send = useCallback((message: ClientMessage) => {
    const ws = socketRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }, []);

  const dismissError = useCallback(() => dispatch({ kind: "dismiss-error" }), []);

  return useMemo(() => ({ ...state, send, dismissError }), [state, send, dismissError]);
}
