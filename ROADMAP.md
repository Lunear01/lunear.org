# Roadmap

Master TODO list and change log. Codebase questions belong in the folder READMEs.

## TODO

- [x] Chu Dai D
- [x] UNO
- [x] Pescalo (Go Fish)
- [x] UNO: "call UNO" catch penalty
- [x] Blackjack: insurance and surrender
- [x] Set the Workers Builds build command to `npm ci && npm run cf-build` (see `docs/deploy.md`)

## Recent changes

- 2026-10-24 — Emotes: a second Shop section sells one-use emotes (30-100 credits, bought 1 or
  5 at a time) that a player aims at another seated player in any game: tomato, paper plane,
  coffee, high five, rose, water balloon, cake, champagne. Table DOs share `emote-relay.ts`
  (stock check, 3 s cooldown, broadcast); pages share `web/src/emotes/`. Plan:
  `action-plans/emotes.md`.
- 2026-10-24 — Static skin prices tiered by design complexity: Bauhaus 1,000, Jade Dynasty
  2,000, Crimson Lacquer 2,500, Midnight Deco 3,000. Animated skins stay at 10,000.
- 2026-10-24 — Four more skins: Jade Dynasty and Bauhaus (static, 8,000), Aurora and
  Thunderstrike (animated, 10,000). Per-skin motion, burst, moment and aura settings now live
  in lookup tables in `web/src/skins/`.
- 2026-10-24 — Skins style card fronts too: a seat's own hand, its played cards, poker hole cards,
  Blackjack hands (shared cards stay classic). Animated skins get their own entrance and ambient
  motion, a burst on each play, full-screen moments (bomb/rocket, Blackjack, UNO call, pot win,
  hand win), seat auras and themed dealing. Plan: `action-plans/skin-faces-effects.md`.
- 2026-10-24 — Shop: card-back skins bought with credits (`/shop`). Two static skins at 8,000
  (Midnight Deco, Crimson Lacquer) and two animated at 10,000 (Nebula, Molten Core: WebGL
  shaders + Motion). A balance below the price, including negative, is refused. A seat's skin
  shows on its face-down cards for every player. Guests can't buy. Plan:
  `action-plans/card-skins.md`.
- 2026-10-24 — CD: Workers Builds runs every test suite before deploying (`npm run cf-build`);
  CI cancels superseded runs. Setup in `docs/deploy.md`.
- 2026-10-24 — Fight the Landlord: the rocket (both jokers) no longer beats a pair. Blackjack: a
  ten-value up card offers insurance too, so a ten-up dealer blackjack can be insured; the
  between-rounds countdown is 20s and shown on screen, and everyone readying up deals early.
- 2026-10-13 — Chu Dai D: 3 is the highest card and 4 the lowest (straight ladder shifts to
  4-5-6-7-8 … J-Q-K-A-2, then 2-3-4-5-6, then 3-4-5-6-7), plus a Hint button. The player who
  made the last play is named under it in Fight the Landlord and UNO, as in Chu Dai D.
- 2026-10-13 — UNO: call UNO as you play or after, catch an uncalled seat for a two-card
  penalty. Blackjack: insurance against an Ace up card, late surrender. Plan:
  `action-plans/uno-call-blackjack-insurance.md`.
- 2026-10-13 — Chu Dai D (2-4 seats, HK Big Two rules), UNO (2-6 seats, own card deck and
  `UnoCard` component), and Pescalo (Go Fish, 2-5 seats) shipped. Plan:
  `action-plans/chudaidi-uno.md`.
- 2026-09-12 — Blackjack: split, double down after a hit, per-seat bets with the stake as the
  minimum. Fight the Landlord and Liar's Bar hold the final play on screen before the
  settlement panel. Fight the Landlord cards select off-turn. Plan:
  `action-plans/table-fixes-2026-09.md`.
- 2026-09-07 — Blackjack shipped (`action-plans/blackjack.md`).
