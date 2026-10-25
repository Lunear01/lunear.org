import { useCallback, useEffect, useMemo, useReducer, useRef } from "react";
import { getGuestToken } from "../api/client";
import type {
  AbortedMessage,
  ClientMessage,
  EmoteMessage,
  ErrorMessage,
  RedactedView,
  SeatStatus,
  ServerMessage,
  SettledMessage,
} from "./chudaidi-types";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

interface GameSocketState {
  status: ConnectionStatus;
  round: number;
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
  error: ErrorMessage | null;
  settled: SettledMessage | null;
  /** Latest emote; `seq` bumps per message so repeats of the same emote still change state. */
  lastEmote: (EmoteMessage & { seq: number }) | null;
  /** Set once an abort voids the table; never clears, since an aborted table never resumes. */
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
  lastEmote: null,
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
        case "emote":
          return { ...state, lastEmote: { ...msg, seq: (state.lastEmote?.seq ?? 0) + 1 } };
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
 * Chu Dai D counterpart to doudizhu's useGameSocket: same connection and
 * reconnect plumbing, pointed at the chudaidi endpoint and protocol types.
 */
export function useChuDaiDSocket(tableId: string) {
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
        `${proto}//${window.location.host}/api/tables/chudaidi/${encodeURIComponent(tableId)}/ws` +
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
          // The server never sends non-JSON frames.
        }
      };

      ws.onclose = () => {
        if (closedByClientRef.current) return;
        dispatch({ kind: "status", status: "reconnecting" });
        const delay = Math.min(BASE_RECONNECT_DELAY_MS * 2 ** attemptRef.current, MAX_RECONNECT_DELAY_MS);
        attemptRef.current += 1;
        reconnectTimerRef.current = setTimeout(connect, delay);
      };

      // onclose owns the reconnect decision; an error always precedes a close.
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
