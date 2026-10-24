# Roadmap

Master TODO list and change log. Codebase questions belong in the folder READMEs.

## TODO

- [x] Chu Dai D
- [x] UNO
- [x] Pescalo (Go Fish)
- [x] UNO: "call UNO" catch penalty
- [x] Blackjack: insurance and surrender

## Recent changes

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
