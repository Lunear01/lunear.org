# blackjack

Pure rules engine for blackjack — players against a house dealer. Published as the workspace package `blackjack`, imported by `worker/` (`BlackjackTableDO`, which drives rounds and holds the shoe) and type-only by `web/`. No I/O and no randomness live here: every entry point takes a shoe the caller has already shuffled (`shuffleCards` / `createSeededRandom` in [cards.ts](./src/cards.ts)).

## Directory Structure

| Path | Purpose |
| --- | --- |
| [src/cards.ts](./src/cards.ts) | `Card`/`Rank`/`Suit` model, shoe construction, shuffle, seeded RNG |
| [src/game.ts](./src/game.ts) | Round state, dealing, insurance, actions, dealer play, settlement, redaction |
| [src/index.ts](./src/index.ts) | Public exports plus the `gameDefinition` registry entry |
| [test/helpers.ts](./test/helpers.ts) | `buildShoe`, `act`, `expectRejected`, `labelsOf` test utilities |
| [test/*.test.ts](./test) | Unit and flow tests, one file per concern |

## Rules as implemented

- Ranks reuse poker's 2-14 numeric scheme (J=11 ... A=14); hand values (faces=10, ace 1 or 11) are computed separately in `handValue`, never from rank comparisons.
- The dealer stands on all 17s, soft included (`DEALER_STANDS_AT = 17`). The dealer only draws when a hand remains for it to beat — if every seat busted or was already a natural, the round finishes without a dealer draw.
- A natural (21 from the two dealt cards) pays 3:2, floored: `settle` adds `Math.floor(1.5 * bet)`. A dealer natural pushes a player natural and beats everything else, decided once insurance is answered, before anyone acts.
- An Ace or ten-value up card opens the `insurance` phase (house rule; standard tables offer it on an Ace only): every dealt seat, naturals included, answers `insure` or `declineInsurance` in any order (`pendingInsurance` lists who is still owed). Insurance costs `Math.floor(bet / 2)`, recorded in `insurance[seat]`. The last answer triggers the dealer's peek: a natural finishes the round at once with insurance paid 2:1; otherwise insurance is lost and play moves to `acting`.
- Actions are `hit`, `stand`, `double`, `split`, `surrender`. Hitting to 21 or past it ends the hand automatically.
- Surrender (late) is allowed only on a hand's first decision — two dealt cards, unsplit, undoubled, no hit (`canSurrender`). The hand ends with outcome `surrender` and loses `Math.ceil(bet / 2)`. A surrendered hand never needs beating, so the dealer draws only for the remaining live hands.
- Double is allowed on any hand still awaiting a decision, regardless of how many cards it holds (including after a hit).
- One split per round, from a still-two-card, still-undecided hand whose cards match in blackjack value — tens and face cards all pair with each other (`splitRank`), an ace pairs only with an ace.
- Split aces draw exactly one card each and stop there; any other split hand plays on normally.
- A two-card 21 on a hand that came from a split is a plain 21, not a natural (`fromSplit` on `HandState`, checked by `isNaturalHand`) — no 3:2 payout.
- Bets are per seat via `CreateGameOptions.bets`; `stake` is both the table minimum and the default bet for any seat missing from `bets`. Each split hand keeps its own bet (doubled independently by a double on that hand).
- Settlement is not zero-sum: `settle` returns each seat's signed delta against the house (win +bet, lose -bet, push 0, blackjack +floor(1.5×bet), surrender -ceil(bet/2), plus +2×insurance on a dealer natural or -insurance otherwise); the house absorbs whatever the seats collectively win or lose.

## State shape

`GameState` is `InsuranceState | ActingState | FinishedState`, discriminated by `phase`. Every phase carries `insurance` (amount bought per seat). `players[seat]` is a `PlayerRoundState` holding `hands: HandState[]` and `activeHand` (the index awaiting a decision; meaningless once every hand is done). A seat holds one hand normally, two after a split. `FinishedState.outcomes[seat]` is an `Outcome[]` index-aligned with `players[seat].hands`, one entry per hand.

`applyAction` rejects with a `RejectionReason` (`wrong-phase`, `not-your-turn`, `cannot-double`, `cannot-split`, `cannot-surrender`) rather than throwing; only `createGame`'s input validation throws. During `insurance`, every game action is `wrong-phase` and a seat not in `pendingInsurance` gets `not-your-turn`.

## Redaction

All hands are dealt face up, so `viewFor` exposes every seat's full cards in every viewer's `RedactedView`. The only hidden fact is the dealer's hole card during `insurance` and `acting` (those views carry `dealerUpCard`, not `dealerCards`); once finished, the full `dealerCards`, computed totals, `dealerNatural`, and signed `insuranceDeltas` are revealed. Insurance amounts and `pendingInsurance` are public in every phase, as at a real table. `viewFor` never indexes `players[viewer]`, so it is safe to call for a seat number not dealt into the round (a spectator).

## MIN_SHOE_CARDS

`MIN_SHOE_CARDS = 156` (a 3-deck shoe). A round draws at most 132 cards — 11 hands (5 seats, each split once, plus the dealer) times a 12-card bust ceiling — so a 156-card shoe can never run dry mid-round. `createGame` throws if handed fewer. Production callers pass a full `SHOE_DECKS` (6-deck, 312-card) shoe; tests pad a scripted prefix up to the floor.

## Test conventions

`buildShoe` (in [test/helpers.ts](./test/helpers.ts)) builds a full shoe from a `ShoeScript`: named seat hands in ascending seat order, then the dealer's two, then `draws` in the exact order the engine consumes them (player hits/doubles in action order, then dealer draws) — matching `createGame`'s and the action handlers' real consumption order. Cards are named by label (`"Ac"`, `"Th"`); a `CardPool` hands out the next unused instance of that label from a 3-deck pool, so naming the same label twice yields two distinct shoe cards. The remainder of the pool pads the shoe past `MIN_SHOE_CARDS`. `act` applies an action and throws (with the rejection reason) if it's unexpectedly refused; `expectRejected` asserts a specific rejection.
