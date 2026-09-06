import { useEffect, useRef, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApiError } from "../api/client";
import {
  lobbyApi,
  pollQuickPlay,
  type CreateGameOptions,
  type CreateGameResult,
  type OpenParty,
} from "../api/lobby";
import { useAuth } from "../context/AuthContext";

const GAME_NAMES: Record<string, string> = {
  doudizhu: "Fight the Landlord",
};

const OPEN_PARTIES_REFRESH_MS = 5000;

/** Distinct, specific copy for the two error shapes the lobby routes document. */
function describeJoinError(err: unknown, context: "party" | "code"): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return "That table just filled up — try another.";
    if (err.status === 404) {
      return context === "code" ? "That invite code doesn't match any table." : "That party is no longer available.";
    }
    return err.message;
  }
  return "Something went wrong — try again.";
}

function relativeTime(iso: string): string {
  const seconds = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}

export default function Lobby() {
  const { gameId = "" } = useParams<{ gameId: string }>();
  const { user } = useAuth();
  const navigate = useNavigate();
  const gameName = GAME_NAMES[gameId] ?? gameId;

  // --- Quick play ------------------------------------------------------------
  const [qpPhase, setQpPhase] = useState<"idle" | "queued" | "error">("idle");
  const [qpError, setQpError] = useState<string | null>(null);
  const cancelPollRef = useRef<(() => void) | null>(null);

  useEffect(() => () => cancelPollRef.current?.(), []);

  const startQuickPlay = () => {
    setQpError(null);
    setQpPhase("queued");
    cancelPollRef.current = pollQuickPlay(
      gameId,
      (result) => {
        if (result.status === "matched" && result.tableId) {
          cancelPollRef.current?.();
          navigate(`/table/${result.tableId}`);
        }
      },
      (err) => {
        setQpPhase("error");
        setQpError(err instanceof ApiError ? err.message : "quick play failed — try again");
      },
    );
  };

  const cancelQuickPlay = async () => {
    cancelPollRef.current?.();
    cancelPollRef.current = null;
    setQpPhase("idle");
    try {
      await lobbyApi.cancelQuickPlay(gameId);
    } catch {
      // best-effort: polling has already stopped client-side either way
    }
  };

  // --- Create game -------------------------------------------------------------
  const [createOpen, setCreateOpen] = useState(false);
  const [created, setCreated] = useState<CreateGameResult | null>(null);
  const [copyHint, setCopyHint] = useState<string | null>(null);

  const copyInviteCode = async () => {
    if (!created?.inviteCode) return;
    try {
      await navigator.clipboard.writeText(created.inviteCode);
      setCopyHint("Copied!");
    } catch {
      setCopyHint("Couldn't copy — select and copy manually.");
    }
  };

  // --- Open parties -------------------------------------------------------------
  const [parties, setParties] = useState<OpenParty[] | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [joiningTableId, setJoiningTableId] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [codeError, setCodeError] = useState<string | null>(null);
  const [codeSubmitting, setCodeSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      if (document.hidden) return;
      lobbyApi
        .listOpenParties(gameId)
        .then((result) => {
          if (!cancelled) setParties(result);
        })
        .catch(() => {
          // Transient error: keep showing the last good list rather than blanking it.
        });
    };
    load();
    const interval = setInterval(load, OPEN_PARTIES_REFRESH_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [gameId]);

  const joinParty = async (tableId: string) => {
    setJoinError(null);
    setJoiningTableId(tableId);
    try {
      const result = await lobbyApi.joinParty(gameId, tableId);
      navigate(`/table/${result.tableId}`);
    } catch (err) {
      setJoinError(describeJoinError(err, "party"));
      setJoiningTableId(null);
    }
  };

  const submitCode = async (event: FormEvent) => {
    event.preventDefault();
    setCodeError(null);
    setCodeSubmitting(true);
    try {
      const result = await lobbyApi.joinByCode(gameId, code.trim());
      navigate(`/table/${result.tableId}`);
    } catch (err) {
      setCodeError(describeJoinError(err, "code"));
    } finally {
      setCodeSubmitting(false);
    }
  };

  return (
    <div className="page">
      <div className="lobby-heading">
        <h1 className="page__title">{gameName} lobby</h1>
        {user && (
          <p className="lobby-balance">
            Your balance:{" "}
            <span className={user.credits < 0 ? "app-header__credits--negative" : ""}>
              {user.credits.toLocaleString()} credits
            </span>
          </p>
        )}
      </div>

      <div className="lobby-grid">
        <section className="card lobby-panel">
          <h2 className="lobby-panel__title">Quick play</h2>
          <p className="lobby-panel__desc">
            Join the queue and get seated as soon as two other players are ready.
          </p>

          {qpPhase === "idle" && (
            <button type="button" className="button button--primary" onClick={startQuickPlay}>
              Find a match
            </button>
          )}

          {qpPhase === "queued" && (
            <>
              <p className="lobby-panel__status">
                <span className="spinner" aria-hidden="true" /> Waiting for players…
              </p>
              <button type="button" className="button" onClick={() => void cancelQuickPlay()}>
                Cancel
              </button>
            </>
          )}

          {qpPhase === "error" && (
            <>
              {qpError && (
                <p className="field-error" role="alert">
                  {qpError}
                </p>
              )}
              <button type="button" className="button button--primary" onClick={startQuickPlay}>
                Try again
              </button>
            </>
          )}
        </section>

        <section className="card lobby-panel">
          <h2 className="lobby-panel__title">Create game</h2>
          <p className="lobby-panel__desc">Set a stake and start a private or public table.</p>

          {created ? (
            <>
              {created.inviteCode ? (
                <>
                  <p className="lobby-panel__desc">Share this invite code:</p>
                  <p className="invite-code">{created.inviteCode}</p>
                  <button type="button" className="button" onClick={() => void copyInviteCode()}>
                    Copy code
                  </button>
                  {copyHint && <p className="field__hint">{copyHint}</p>}
                </>
              ) : null}
              <button
                type="button"
                className="button button--primary"
                onClick={() => navigate(`/table/${created.tableId}`)}
              >
                Go to table
              </button>
            </>
          ) : (
            <button type="button" className="button button--primary" onClick={() => setCreateOpen(true)}>
              Create game
            </button>
          )}
        </section>

        <section className="card lobby-panel">
          <h2 className="lobby-panel__title">Open parties</h2>
          <p className="lobby-panel__desc">Public tables with a free seat.</p>

          {joinError && (
            <p className="field-error" role="alert">
              {joinError}
            </p>
          )}

          {parties === null && <p className="lobby-panel__empty">Loading…</p>}
          {parties?.length === 0 && (
            <p className="lobby-panel__empty">No open parties yet — check back soon.</p>
          )}
          {parties && parties.length > 0 && (
            <ul className="party-list">
              {parties.map((party) => (
                <li key={party.tableId} className="party-list__row">
                  <span>{party.hostUsername}</span>
                  <span>
                    {party.seatsFilled}/{party.seatsTotal} seats
                  </span>
                  <span>{party.stake} stake</span>
                  <span className="field__hint">{relativeTime(party.createdAt)}</span>
                  <button
                    type="button"
                    className="button button--small"
                    disabled={joiningTableId === party.tableId}
                    onClick={() => void joinParty(party.tableId)}
                  >
                    {joiningTableId === party.tableId ? "Joining…" : "Join"}
                  </button>
                </li>
              ))}
            </ul>
          )}

          <form className="lobby-panel__row lobby-panel__code-form" onSubmit={(e) => void submitCode(e)}>
            <label className="field">
              <span className="field__label">Have a code?</span>
              <input
                className="field__input"
                type="text"
                value={code}
                onChange={(e) => setCode(e.target.value.toUpperCase())}
                placeholder="ABC123"
                maxLength={16}
              />
            </label>
            <button type="submit" className="button" disabled={codeSubmitting || code.trim().length === 0}>
              {codeSubmitting ? "Joining…" : "Join"}
            </button>
          </form>
          {codeError && (
            <p className="field-error" role="alert">
              {codeError}
            </p>
          )}
        </section>
      </div>

      {createOpen && (
        <CreateGameDialog
          gameId={gameId}
          onClose={() => setCreateOpen(false)}
          onCreated={(result) => {
            setCreateOpen(false);
            if (result.inviteCode) {
              setCreated(result);
            } else {
              navigate(`/table/${result.tableId}`);
            }
          }}
        />
      )}
    </div>
  );
}

function CreateGameDialog({
  gameId,
  onClose,
  onCreated,
}: {
  gameId: string;
  onClose: () => void;
  onCreated: (result: CreateGameResult) => void;
}) {
  const [stake, setStake] = useState("100");
  const [inviteOnly, setInviteOnly] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    const parsed = Number(stake);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 10_000) {
      setError("stake must be a whole number between 1 and 10,000");
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const options: CreateGameOptions = { stake: parsed, inviteOnly };
      const result = await lobbyApi.createGame(gameId, options);
      onCreated(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to create game");
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="create-game-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="create-game-title" className="modal__title">
          Create a game
        </h2>

        <label className="field">
          <span className="field__label">Stake</span>
          <input
            className="field__input"
            type="number"
            min={1}
            max={10_000}
            value={stake}
            onChange={(e) => setStake(e.target.value)}
            autoFocus
          />
        </label>

        <label className="field field--checkbox">
          <input
            type="checkbox"
            checked={inviteOnly}
            onChange={(e) => setInviteOnly(e.target.checked)}
          />
          <span>Invite-only</span>
        </label>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <div className="modal__actions">
          <button type="button" className="button" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button
            type="button"
            className="button button--primary"
            onClick={() => void handleSubmit()}
            disabled={submitting}
          >
            {submitting ? "Creating…" : "Create"}
          </button>
        </div>
      </div>
    </div>
  );
}
