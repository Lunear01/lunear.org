import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { EmoteClientMessage } from "worker/src/durable-objects/emote-protocol";
import { EMOTE_COOLDOWN_MS } from "worker/src/durable-objects/emote-protocol";
import { EMOTES, type EmoteId } from "worker/src/shop/emotes";
import { fetchShop } from "../api/shop";
import { useAuth } from "../context/AuthContext";
import { type EmoteEvent, EmoteLayer } from "./EmoteLayer";
import { isMuted, setMuted } from "./sound";
import "./emotes.css";

interface SeatRow {
  seat: number;
  userId: string | null;
  username: string | null;
}

interface EmoteBarProps {
  seats: readonly SeatRow[] | null;
  mySeat: number | null;
  event: EmoteEvent | null;
  send: (msg: EmoteClientMessage) => void;
}

// Tab-wide, so a remount (reconnect, page re-render) can't skip the cooldown.
let coolUntil = 0;

/** Emote picker (target, then emote) plus the flight layer. Drop into any table page. */
export function EmoteBar({ seats, mySeat, event, send }: EmoteBarProps) {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  const [target, setTarget] = useState<number | null>(null);
  const [stock, setStock] = useState<Record<string, number> | null>(null);
  const [, tick] = useState(0);
  const [muted, setMutedState] = useState(isMuted);

  const others = (seats ?? []).filter((s) => s.userId !== null && s.seat !== mySeat);

  useEffect(() => {
    if (!open) return;
    fetchShop()
      .then((s) => setStock(s.emoteStock))
      .catch(() => setStock({}));
  }, [open]);

  const cooling = Date.now() < coolUntil;

  // Re-render when the cooldown ends so the buttons re-enable.
  useEffect(() => {
    const wait = coolUntil - Date.now();
    if (wait <= 0) return;
    const t = setTimeout(() => tick((n) => n + 1), wait);
    return () => clearTimeout(t);
  }, [cooling]);

  const fire = (emoteId: EmoteId) => {
    if (target === null) return;
    send({ type: "emote", emoteId, target });
    setStock((s) => (s ? { ...s, [emoteId]: Math.max(0, (s[emoteId] ?? 0) - 1) } : s));
    coolUntil = Date.now() + EMOTE_COOLDOWN_MS;
    setOpen(false);
    setTarget(null);
  };

  const canUse = mySeat !== null && others.length > 0;

  return (
    <>
      <EmoteLayer event={event} seats={seats} mySeat={mySeat} />
      {canUse && (
        <div className="emote-bar">
          {open && (
            <div className="emote-panel" role="dialog" aria-label="Send an emote">
              {target === null ? (
                <>
                  <p className="emote-panel__title">Send an emote to</p>
                  <div className="emote-panel__targets">
                    {others.map((s) => (
                      <button key={s.seat} type="button" className="button button--small" onClick={() => setTarget(s.seat)}>
                        {s.username ?? `Seat ${s.seat + 1}`}
                      </button>
                    ))}
                  </div>
                </>
              ) : (
                <>
                  <p className="emote-panel__title">
                    <button type="button" className="emote-panel__back" onClick={() => setTarget(null)} aria-label="Back to players">
                      ‹
                    </button>
                    To {others.find((s) => s.seat === target)?.username ?? "player"}
                  </p>
                  <div className="emote-panel__grid">
                    {EMOTES.map((e) => {
                      const count = stock?.[e.id] ?? 0;
                      return (
                        <button
                          key={e.id}
                          type="button"
                          className="emote-chip"
                          disabled={count === 0 || cooling}
                          onClick={() => fire(e.id)}
                          title={count === 0 ? `${e.name}: none left` : e.name}
                        >
                          <span className="emote-chip__glyph" aria-hidden="true">{e.glyph}</span>
                          <span className="emote-chip__name">{e.name}</span>
                          <span className="emote-chip__count">{stock === null ? "…" : `×${count}`}</span>
                        </button>
                      );
                    })}
                  </div>
                  <p className="emote-panel__foot">
                    <button
                      type="button"
                      className="emote-panel__mute"
                      aria-pressed={muted}
                      onClick={() => {
                        setMuted(!muted);
                        setMutedState(!muted);
                      }}
                    >
                      {muted ? "🔇 Sound off" : "🔊 Sound on"}
                    </button>
                    {user?.is_guest ? (
                      <>Guests can't buy emotes. <Link to="/register">Register</Link> to get some.</>
                    ) : (
                      <Link to="/shop#emotes">Get more emotes</Link>
                    )}
                  </p>
                </>
              )}
            </div>
          )}
          <button
            type="button"
            className="button emote-bar__toggle"
            aria-expanded={open}
            disabled={cooling && !open}
            onClick={() => {
              setOpen((o) => !o);
              setTarget(others.length === 1 ? others[0].seat : null);
            }}
          >
            🍅 Emotes
          </button>
        </div>
      )}
    </>
  );
}
