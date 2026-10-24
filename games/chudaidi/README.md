# chudaidi

Pure rules engine for Chu Dai D (鋤大D, Hong Kong Big Two). Published as the workspace package `chudaidi`, imported by `worker/` (`ChuDaiDTableDO`, which drives hands and shuffles the deck) and type-only by `web/`. No I/O and no randomness live here: every entry point takes a deck the caller has already shuffled (`shuffleDeck` / `createSeededRandom` in [cards.ts](./src/cards.ts)).

## Directory Structure

| Path | Purpose |
| --- | --- |
| [src/cards.ts](./src/cards.ts) | `Card`/`Rank`/`Suit` model, 52-card deck, total card order, shuffle, seeded RNG |
| [src/deal.ts](./src/deal.ts) | `Seat` (0-3), 13-card deal per active seat, seat rotation |
| [src/combos.ts](./src/combos.ts) | `classifyCombo` (shape of a selection) and `beats` (comparison) |
| [src/game.ts](./src/game.ts) | Hand state, actions, redaction, settlement |
| [src/suggest.ts](./src/suggest.ts) | `suggestPlay`, the weakest legal play for the table's Hint button |
| [src/index.ts](./src/index.ts) | Public exports plus the `gameDefinition` registry entry |
| [test/helpers.ts](./test/helpers.ts) | `buildDealOrder`, `cardsOf`, `act`, `expectRejected`, `play`, `pass` |
| [test/*.test.ts](./test) | Unit and flow tests, one file per concern |

## Rules as implemented

- 2-4 seats (`activeSeats`), 13 cards each from a 52-card deck. Seat N always takes deck block `[13N, 13N+13)`; an inactive seat's block stays undealt.
- Rank order 4 < 5 < … < K < A < 2 < 3: the 3 is the highest card, the 4 the lowest. Rank numbers stay 3..15 like doudizhu so `web/` reuses `PlayingCard`; `rankStrength` maps them to 0..12. Suit order ♦ < ♣ < ♥ < ♠. `cardValue` = strength × 4 + suit gives every card a unique strength.
- The seat holding the lowest dealt card (4♦ at four seats) leads. That first play must include it (`leadCardId`, rejection `must-include-lead-card`); the rule lapses once any play lands.
- Combos: single, pair, triple, and five-card hands ranked straight < flush < full house < four of a kind + 1 < straight flush. Four cards is never a play.
- Straight ladder: 4-5-6-7-8 up to J-Q-K-A-2 by top card, then 2-3-4-5-6, then 3-4-5-6-7 highest. Q-K-A-2-3 and A-2-3-4-5 are not straights. Equal straights break on the suit of the strongest card (the 3 in both wrap straights).
- Pairs compare by rank, then by the higher suit held. Triples, full houses and four of a kind compare by the rank of the set. Flushes compare by suit first, then strongest card.
- A play must match the card count on the table (`wrong-card-count`) and then beat it (`must-beat-previous`). Passing on a free lead is refused (`cannot-pass-on-lead`).
- When the turn returns to the seat that made the last play, the trick clears and that seat leads freely.
- The hand ends when a seat empties its hand. `settle` charges each loser `cardsLeft × multiplier × baseStake` (multiplier 1 for 1-9 cards, 2 for 10-12, 3 for 13 — `cardMultiplier`) and pays the winner the sum, so deltas sum to zero. Inactive seats settle at 0.

- `suggestPlay(hand, toBeat, leadCardId)` returns the weakest same-count combo that beats `toBeat`, the lead card on the first play, the weakest single on a free lead, or null when nothing beats the table.

## State shape

`GameState` is `PlayingState | FinishedState`, discriminated by `phase`. `PlayingState` holds every hand, `currentTurn`, `lastPlay` (seat + `Combo`, null on a free lead), `leadCardId` and a `history` of plays and passes. `FinishedState` keeps `hands` (cards left) and `winner`.

`applyAction` rejects with a `RejectionReason` rather than throwing; only `createGame`'s input validation throws (wrong deck size, bad `activeSeats`).

## Redaction

`viewFor(state, seat)` returns the viewer's own `hand` and every seat's `handCounts` while playing; `lastPlay` cards and `history` are public. Once finished, every remaining hand is public. A seat outside `activeSeats` gets an empty hand, so a spectator view is safe.

## Test conventions

`buildDealOrder` (in [test/helpers.ts](./test/helpers.ts)) builds a 52-card deal from named 13-card blocks per seat; seats left out are filled from the remaining deck in order, so a fixture names only the hands it cares about. `act` applies an action and throws with the rejection reason if refused; `expectRejected` asserts a specific rejection.
