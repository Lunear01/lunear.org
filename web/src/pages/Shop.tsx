import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { SkinId, SkinItem } from "worker/src/shop/catalog";
import { ApiError } from "../api/client";
import { type ShopState, buyItem, equipItem, fetchShop } from "../api/shop";
import { useAuth } from "../context/AuthContext";
import { PokerCard } from "../components/PokerCard";
import { SkinArt, skinHostClass } from "../skins/SkinArt";
import { SkinBurst } from "../skins/effects/SkinBurst";
import { SkinMoment } from "../skins/effects/SkinMoment";
import type { Card } from "../ws/poker-types";
import "../styles/shop.css";

const PREVIEW_FRONTS: Card[] = [
  { id: "preview-as", rank: 14, suit: "s" },
  { id: "preview-kh", rank: 13, suit: "h" },
];

const KIND_LABEL: Record<SkinItem["kind"], string> = { default: "Default", static: "Static", animated: "Animated" };

export default function Shop() {
  const { user, refresh } = useAuth();
  const [state, setState] = useState<ShopState | null>(null);
  const [busy, setBusy] = useState<SkinId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchShop()
      .then(setState)
      .catch((err: unknown) => setError(err instanceof ApiError ? err.message : "could not load the shop"));
  }, []);

  const run = async (itemId: SkinId, action: (id: SkinId) => Promise<ShopState>) => {
    setBusy(itemId);
    setError(null);
    try {
      setState(await action(itemId));
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "something went wrong");
    } finally {
      setBusy(null);
    }
  };

  if (!state) {
    return <div className="page">{error ? <p className="field-error">{error}</p> : <p className="page-loading">Loading…</p>}</div>;
  }

  return (
    <div className="page">
      <h1 className="page__title">Shop</h1>
      <p className="shop__intro">
        Card backs show on your face-down cards for everyone at the table. Balance:{" "}
        <strong className={state.credits < 0 ? "shop__credits--negative" : ""}>{state.credits.toLocaleString()}</strong> credits.
      </p>
      {user?.is_guest && (
        <p className="shop__notice">
          Guests can preview skins but not buy them. <Link to="/register">Register</Link> to keep what you buy.
        </p>
      )}
      {error && <p className="field-error" role="alert">{error}</p>}
      <div className="shop-grid">
        {state.items.map((item) => (
          <ShopItem
            key={item.id}
            item={item}
            owned={state.owned.includes(item.id)}
            equipped={state.equipped === item.id}
            credits={state.credits}
            guest={user?.is_guest ?? false}
            busy={busy === item.id}
            onBuy={() => void run(item.id, buyItem)}
            onEquip={() => void run(item.id, equipItem)}
          />
        ))}
      </div>
    </div>
  );
}

function ShopItem({
  item,
  owned,
  equipped,
  credits,
  guest,
  busy,
  onBuy,
  onEquip,
}: {
  item: SkinItem;
  owned: boolean;
  equipped: boolean;
  credits: number;
  guest: boolean;
  busy: boolean;
  onBuy: () => void;
  onEquip: () => void;
}) {
  const affordable = credits >= item.price;
  const [demo, setDemo] = useState(0);
  let action;
  if (equipped) {
    action = <span className="shop-item__equipped">Equipped</span>;
  } else if (owned) {
    action = (
      <button type="button" className="button button--primary button--small" disabled={busy} onClick={onEquip}>
        Equip
      </button>
    );
  } else {
    action = (
      <button
        type="button"
        className="button button--primary button--small"
        disabled={busy || guest || !affordable}
        onClick={onBuy}
        title={guest ? "Register to buy" : affordable ? undefined : "Not enough credits"}
      >
        {guest ? "Register to buy" : affordable ? "Buy" : "Not enough"}
      </button>
    );
  }

  return (
    <div className={`shop-item ${equipped ? "shop-item--equipped" : ""}`}>
      <div className="shop-item__preview" aria-hidden="true">
        <div className={`card-back shop-item__card ${skinHostClass(item.id)}`}>
          <SkinArt skin={item.id} index={0} />
        </div>
        {PREVIEW_FRONTS.map((card, i) => (
          // Keyed by demo so the entrance replays with the effects preview.
          <PokerCard key={`${card.id}-${demo}`} card={card} skin={item.id} index={i + 1} />
        ))}
        <SkinBurst skin={item.id} burstKey={demo || null} />
      </div>
      <SkinMoment skin={item.id} momentKey={demo || null} label={item.name} />
      <div className="shop-item__body">
        <h2 className="shop-item__name">
          {item.name}
          <span className={`shop-item__kind shop-item__kind--${item.kind}`}>{KIND_LABEL[item.kind]}</span>
        </h2>
        <p className="shop-item__blurb">{item.blurb}</p>
        {item.kind === "animated" && (
          <button type="button" className="button button--ghost button--small shop-item__demo" onClick={() => setDemo((d) => d + 1)}>
            Preview effects
          </button>
        )}
        <div className="shop-item__footer">
          <span className="shop-item__price">{item.price === 0 ? "Free" : `${item.price.toLocaleString()} credits`}</span>
          {action}
        </div>
      </div>
    </div>
  );
}
