import type { SkinId, SkinItem } from "worker/src/shop/catalog";
import { apiGet, apiPost } from "./client";

export interface ShopState {
  items: SkinItem[];
  owned: SkinId[];
  equipped: SkinId;
  credits: number;
}

export function fetchShop(): Promise<ShopState> {
  return apiGet<ShopState>("/api/shop");
}

export function buyItem(itemId: SkinId): Promise<ShopState> {
  return apiPost<ShopState>("/api/shop/buy", { itemId });
}

export function equipItem(itemId: SkinId): Promise<ShopState> {
  return apiPost<ShopState>("/api/shop/equip", { itemId });
}
