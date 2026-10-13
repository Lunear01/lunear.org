# uno

Pure rules engine for UNO. Published as the workspace package `uno`, imported by `worker/` (`UnoTableDO`, which drives hands and holds the deck) and type-only by `web/`. No I/O and no randomness live here: `createGame` takes a deck the caller has already shuffled, and `applyAction` takes a `RandomSource` for the one mid-hand reshuffle (`shuffleDeck` / `createSeededRandom` in [cards.ts](./src/cards.ts)).

## Directory Structure

| Path | Purpose |
| --- | --- |
| [src/cards.ts](./src/cards.ts) | `Card`/`Color`/`Kind` model, the 108-card deck, points, shuffle, seeded RNG, hand sort |
| [src/game.ts](./src/game.ts) | Hand state, dealing, actions, turn order, settlement, redaction |
| [src/index.ts](./src/index.ts) | Public exports plus the `gameDefinition` registry entry (2-6 seats) |
| [test/helpers.ts](./test/helpers.ts) | `buildDeck`, `newGame`, `act`, `expectRejected` test utilities |
| [test/*.test.ts](./test) | Unit and flow tests, one file per concern |

## Card model

`Card` is `{ id, color, kind, value }`. `color` is one of `red`/`yellow`/`green`/`blue`, or `null` for a wild. `kind` is `number` (with `value` 0-9), `skip`, `reverse`, `draw2`, `wild`, or `wild4`. Ids encode colour letter, symbol and copy: `r7a`, `bSb` (blue skip, second copy), `W4c` (wild draw four). `createDeck` builds 108 cards: per colour one 0, two of each 1-9, two of each action; four of each wild.

## Rules as implemented

- 2-6 seats (`activeSeats`), 7 cards each, dealt as consecutive blocks off the top of the deck in seat order. The first discard is flipped from the next card; action and wild cards flipped there go to the bottom of the draw pile until a number card turns up.
- A play matches the top discard by colour (`currentColor`), by number, or by action kind. On top of a wild only the chosen colour matters. Wilds always match and require a `color` in the action (`color-required`).
- Wild Draw Four is refused while the hand holds another card of the current colour (`wild-draw-four-not-allowed`).
- Draw Two and Wild Draw Four make the next seat draw and lose the turn; no stacking. Skip skips the next seat. Reverse flips `direction`; at two seats it also skips, so the player goes again.
- `draw` takes one card. If it is playable the turn stays with `pendingDraw` set to its id and only that card may be played (`must-play-drawn-card`), or the seat may `pass`. If it is not playable the turn moves on at once. `pass` is legal only with a pending draw (`cannot-pass`); a second `draw` is `already-drew`.
- When the draw pile runs dry it refills from the discard pile minus its top card, shuffled with the `RandomSource` passed to `applyAction`. With nothing left to draw at all the turn passes with a zero-count `drew` event.
- A card's penalty applies even when it is the player's last card; then the hand finishes with that seat as `winner`.
- Call UNO: a play that leaves one card may carry `uno: true`; a seat holding exactly one card may also send `callUno` later, on anyone's turn (`cannot-call-uno` otherwise, or when already called). A one-card seat that has not called is `unoVulnerable` until the next `play`, `draw`, or `pass` by any seat.
- Catch: `catchUno { target }` from any other active seat while the target is vulnerable makes the target draw two (reshuffling through the RNG if needed) and clears vulnerability; `nothing-to-catch` otherwise. The turn does not move.
- `unoCalled` lists called seats still on one card; a seat drops off once its hand grows past one. A vulnerable seat that plays its last card wins as usual.
- Points: numbers at face value, Skip/Reverse/Draw Two 20, wilds 50. `settle` has each loser pay `round(points × baseStake / 10)` to the winner; absent seats settle at 0; deltas sum to zero.

## State shape

`GameState` is `PlayingState | FinishedState`, discriminated by `phase`. `PlayingState` carries every hand, both piles (top at the end of the array), `currentColor`, `direction`, `currentTurn`, `pendingDraw`, `unoVulnerable`, `unoCalled`, and `lastEvents`, the ordered `GameEvent`s the most recent action produced (played / drew / passed / skipped / reversed / reshuffled / called-uno / caught) for the UI to narrate. `FinishedState` keeps every hand, `points` per seat, and the winner.

`applyAction` rejects with a `RejectionReason` rather than throwing; only `createGame`'s input validation throws.

## Redaction

`viewFor` exposes the viewer's own hand, every seat's hand count, the top discard, the colour in force, the direction, the draw pile size, whether the current seat is deciding on a drawn card (`awaitingDrawDecision`), `pendingDraw` only to the seat that drew it, and the public `unoVulnerable` seat and `unoCalled` list. Neither pile's contents are ever sent mid-hand. A seat outside `activeSeats` sees an empty hand. Once finished every hand is public.

## Test conventions

`buildDeck` (in [test/helpers.ts](./test/helpers.ts)) takes a `DealScript`: exact 7-card hands per seat, the cards flipped for the first discard in order, and the draw pile top-first; the rest of the deck pads the bottom. `act` applies an action that must succeed (throwing with the reason otherwise) and defaults the RNG to one that throws, so an unexpected reshuffle fails loudly; pass `seeded()` where a reshuffle is intended. `expectRejected` asserts a specific rejection.
