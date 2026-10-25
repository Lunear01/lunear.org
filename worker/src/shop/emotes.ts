// Consumable emotes. Imported by web for names, prices, and glyphs.

export type EmoteId = "tomato" | "paper-plane" | "coffee" | "high-five" | "rose" | "water-balloon" | "cake" | "champagne";

export interface EmoteItem {
  readonly id: EmoteId;
  readonly name: string;
  readonly glyph: string;
  readonly price: number;
  /** Caption verb: "<from> <verb> <to>". */
  readonly verb: string;
}

export const EMOTES: readonly EmoteItem[] = [
  { id: "tomato", name: "Tomato", glyph: "🍅", price: 30, verb: "threw a tomato at" },
  { id: "paper-plane", name: "Paper Plane", glyph: "✈️", price: 30, verb: "sent a paper plane to" },
  { id: "coffee", name: "Coffee", glyph: "☕", price: 40, verb: "poured a coffee for" },
  { id: "high-five", name: "High Five", glyph: "✋", price: 40, verb: "high-fived" },
  { id: "rose", name: "Rose", glyph: "🌹", price: 50, verb: "tossed a rose to" },
  { id: "water-balloon", name: "Water Balloon", glyph: "🎈", price: 60, verb: "lobbed a water balloon at" },
  { id: "cake", name: "Cake", glyph: "🎂", price: 80, verb: "caked" },
  { id: "champagne", name: "Champagne", glyph: "🍾", price: 100, verb: "popped champagne for" },
];

export const EMOTE_BUNDLES = [1, 5] as const;

export function getEmote(id: unknown): EmoteItem | undefined {
  return EMOTES.find((e) => e.id === id);
}
