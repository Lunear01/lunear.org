// Shop catalog. Imported by web for names, prices, and skin ids.

export type SkinId = "classic" | "midnight-deco" | "crimson-lacquer" | "nebula" | "molten-core";

export interface SkinItem {
  readonly id: SkinId;
  readonly name: string;
  /** "static" = CSS only; "animated" = WebGL shader + Motion. */
  readonly kind: "default" | "static" | "animated";
  readonly price: number;
  readonly blurb: string;
}

export const SKINS: readonly SkinItem[] = [
  { id: "classic", name: "Classic Felt", kind: "default", price: 0, blurb: "The house back." },
  { id: "midnight-deco", name: "Midnight Deco", kind: "static", price: 8000, blurb: "Navy and gold art-deco sunburst." },
  { id: "crimson-lacquer", name: "Crimson Lacquer", kind: "static", price: 8000, blurb: "Red lacquer with gold cloud scrolls." },
  { id: "nebula", name: "Nebula", kind: "animated", price: 10000, blurb: "Living gas clouds and twinkling stars." },
  { id: "molten-core", name: "Molten Core", kind: "animated", price: 10000, blurb: "Lava flowing through cracked obsidian." },
];

export function getSkin(id: string): SkinItem | undefined {
  return SKINS.find((s) => s.id === id);
}

/** Unknown or NULL stored values fall back to classic. */
export function toSkinId(value: unknown): SkinId {
  return typeof value === "string" && getSkin(value) ? (value as SkinId) : "classic";
}
