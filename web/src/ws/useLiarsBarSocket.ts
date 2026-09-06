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
} from "./liarsbar-types";

export type ConnectionStatus = "connecting" | "open" | "reconnecting" | "closed";

interface DisplayedState {
  readonly round: number;
  readonly seats: readonly SeatStatus[];
  readonly view: RedactedView | null;
}

interface GameSocketState {
  status: ConnectionStatus;
  round: number;
  seats: readonly SeatStatus[] | null;
  view: RedactedView | null;
  error: ErrorMessage | null;
  settled: SettledMessage | null;
  aborted: AbortedMessage | null;
  /**
   * A `state` frame received while a "roundEnd" reveal is still on screen —
   * held back rather than applied immediately (see useLiarsBarSocket's doc
   * comment for why). Null whenever there's nothing queued.
   */
  pending: DisplayedState | null;
  /**
   * Set when the reveal's hold timer (or a "Continue" tap) fires before the
   * queued frame has actually arrived — the near-simultaneous server design
   * means this should be rare, but it closes the race: the next `state`
   * frame is then applied the instant it arrives instead of being queued.
   */
  releaseRequested: boolean;
  /**
   * Increments once per distinct roundEnd reveal actually displayed. A
   * match's wire-level `round` counter only bumps at the NEXT full match
   * (ready-up -> deal, see StateMessage's doc comment) — a single match can
   * run through many challenge resolutions, each its own roundEnd, all
   * sharing that same `round` number. The page keys its reveal component on
   * this counter (not `round`) so every occurrence gets a fresh mount
   * (fresh flip/verdict/roulette animation) even mid-match.
   */
  revealSeq: number;
}

type Action =
  | { kind: "status"; status: ConnectionStatus }
  | { kind: "server-message"; message: ServerMessage }
  | { kind: "dismiss-error" }
  | { kind: "release-round-end" };

const initialState: GameSocketState = {
  status: "connecting",
  round: 0,
  seats: null,
  view: null,
  error: null,
  settled: null,
  aborted: null,
  pending: null,
  releaseRequested: false,
  revealSeq: 0,
};

/** Apply a `state` frame as the immediately-displayed state (the non-buffered path). */
function applyState(state: GameSocketState, next: DisplayedState): GameSocketState {
  // A settlement overlay belongs to the round it settled; a fresh round
  // (ready-up -> deal, or roundEnd -> next round) means it's done showing.
  const settled = state.settled && next.round !== state.settled.round ? null : state.settled;
  return {
    ...state,
    round: next.round,
    seats: next.seats,
    view: next.view,
    settled,
    pending: null,
    releaseRequested: false,
    revealSeq: next.view?.phase === "roundEnd" ? state.revealSeq + 1 : state.revealSeq,
  };
}

function reducer(state: GameSocketState, action: Action): GameSocketState {
  switch (action.kind) {
    case "status":
      return { ...state, status: action.status };
    case "dismiss-error":
      return { ...state, error: null };
    case "release-round-end": {
      if (state.pending) return applyState(state, state.pending);
      // Nothing queued yet — arm early release for whenever it lands.
      return { ...state, releaseRequested: true };
    }
    case "server-message": {
      const msg = action.message;
      switch (msg.type) {
        case "state": {
          const next: DisplayedState = { round: msg.round, seats: msg.seats, view: msg.view };
          // Only buffer when we're currently showing a roundEnd reveal AND
          // nobody has already asked to move past it early.
          if (state.view?.phase === "roundEnd" && !state.releaseRequested) {
            return { ...state, pending: next };
          }
          return applyState(state, next);
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
/** How long a "roundEnd" reveal (verdict + roulette beat) stays on screen
 * before auto-advancing to the queued next round, absent an earlier "Continue" tap. */
export const ROUND_END_HOLD_MS = 4000;

/**
 * Parallel counterpart to doudizhu's useGameSocket (web/src/ws/useGameSocket.ts) —
 * kept as a separate hook rather than genericizing the shared one, since
 * that would require touching a file doudizhu's Table.tsx also depends on
 * for a one-off, game-specific need (the roundEnd reveal buffer below). The
 * connection/reconnect plumbing is intentionally identical.
 *
 * The one behavioral addition: the server broadcasts a "roundEnd" `state`
 * frame (the just-resolved challenge's reveal) immediately followed by the
 * next round's "playing" `state` frame, in the same breath (see
 * liarsbar-protocol.ts's StateMessage doc comment). Applying frames as they
 * arrive would flash the reveal for a single render and jump straight to
 * the new deal, so a `state` frame arriving while a roundEnd view is
 * displayed is held in `pending` instead — released after `ROUND_END_HOLD_MS`
 * or an explicit `continueRoundEnd()` call, whichever comes first (see
 * `releaseRequested` above for the arrival-order race this closes). A
 * reconnect only ever delivers a single, current `state` frame — and since
 * roundEnd is a fire-once broadcast rather than queryable table state (the
 * DO deals the next round synchronously right after producing it), a fresh
 * connection's first frame is never itself a roundEnd view, so this
 * buffering never blocks it from being applied immediately.
 */
export function useLiarsBarSocket(tableId: string) {
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
        `${proto}//${window.location.host}/api/tables/liarsbar/${encodeURIComponent(tableId)}/ws` +
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

      // A transport error is always followed by a close event; let onclose
      // own the reconnect decision so it isn't scheduled twice.
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
  const continueRoundEnd = useCallback(() => dispatch({ kind: "release-round-end" }), []);

  // Auto-advance the hold timer whenever a roundEnd reveal starts showing.
  // Keyed on `round` so a brand-new roundEnd (even one that lands before the
  // previous timer would have fired — not reachable given the buffering
  // above, but cheap to guard) restarts the clock rather than reusing a
  // stale one.
  useEffect(() => {
    if (state.view?.phase !== "roundEnd") return;
    const t = setTimeout(() => dispatch({ kind: "release-round-end" }), ROUND_END_HOLD_MS);
    return () => clearTimeout(t);
  }, [state.view, state.round]);

  return useMemo(
    () => ({ ...state, send, dismissError, continueRoundEnd }),
    [state, send, dismissError, continueRoundEnd],
  );
}
