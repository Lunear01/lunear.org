# pescalo

Pure rules engine for Pescalo, the house name for Go Fish. Published as the workspace package `pescalo`, imported by `worker/` (`PescaloTableDO`, which shuffles the deck and picks the first seat) and type-only by `web/`. No I/O and no randomness live here: every entry point takes a deck the caller has already shuffled (`shuffleDeck` / `createSeededRandom` in [cards.ts](./src/cards.ts)). Draws come off the top of that fixed order, so a game is fully determined by its deck and first seat.

## Directory Structure

| Path | Purpose |
| --- | --- |
| [src/cards.ts](./src/cards.ts) | `Card`/`Rank`/`Suit` model, 52-card deck, shuffle, seeded RNG |
| [src/game.ts](./src/game.ts) | Hand state, the `ask` action, books, turn passing, redaction, settlement |
| [src/index.ts](./src/index.ts) | Public exports plus the `gameDefinition` registry entry |
| [test/helpers.ts](./test/helpers.ts) | `buildDealOrder`, `game`, `ask`, `expectRejected`, `cardsOf` |
| [test/*.test.ts](./test) | Unit and flow tests, one file per concern |

## Rules as implemented

- 2-5 seats (`activeSeats`). `handSizeFor`: 7 cards each at two seats, 5 at three or more. Hands come off the deck as consecutive blocks in seat order; the rest is the pool, drawn from the next card dealt.
- Cards use doudizhu's scheme (ranks 3..15 with A=14 and 2=15, suits D/C/H/S) so `web/` reuses `PlayingCard`. Only rank matters here.
- The one action is `ask { target, rank }`: `target` must be another active seat (`invalid-target`), `rank` one of the 13 (`invalid-rank`) that the asker holds (`rank-not-in-hand`).
- A hit hands every card of that rank to the asker, who goes again. A miss ("go fish") draws one pool card: the asked rank is shown (`drew-match`) and the asker goes again; anything else stays hidden (`drew-hidden`) and the turn passes to the next active seat. With an empty pool the turn passes without a draw.
- Four of a rank form a book the moment a hand holds them — after the deal, a hit, or a draw (`formBooks`). Books are public.
- A seat reaching its turn with an empty hand draws one pool card first (`refill`); with the pool empty too it is skipped (`skipped`). Seats are tried in order until one can act.
- The hand finishes once all 13 books exist. `winners` holds every seat with the most books.
- `settle` is pairwise: each seat gains one `baseStake` per book of difference over every seat with fewer, which reduces to `baseStake × (players × ownBooks − 13)`. Deltas sum to zero; inactive seats settle at 0.

## State shape

`GameState` is `PlayingState | FinishedState`, discriminated by `phase`. `PlayingState` holds every hand, the `pool` (top is the last element), `books` per seat (ranks in the order made), `currentTurn`, and `lastEvents`. `lastEvents` narrates the last action in order (`asked`, `hit`, `go-fish`, `drew-match`, `drew-hidden`, `book`, `refill`, `skipped`) and resets on every action. `FinishedState` keeps `books`, `winners`, and the closing events.

`applyAction` rejects with a `RejectionReason` rather than throwing; only `createGame`'s input validation throws (wrong deck size, bad `activeSeats`, inactive `firstSeat`).

## Redaction

`viewFor(state, seat)` returns the viewer's own `hand`, every seat's `handCounts`, `books`, `poolCount`, `currentTurn`, and `lastEvents`. A `drew-hidden` event carries only the seat, so a miss never reveals the drawn card. Once finished, the view is the finished state itself. A seat outside `activeSeats` gets an empty hand, so a spectator view is safe.

## Test conventions

`buildDealOrder` (in [test/helpers.ts](./test/helpers.ts)) builds a 52-card deal from named hands per seat and a named pool top (first id drawn first); every unnamed card fills in deck order. `game` wraps it with `createGame`. `ask` applies an action and throws with the rejection reason if refused; `expectRejected` asserts a specific rejection. Branches that need an empty pool build a `PlayingState` literal directly.
