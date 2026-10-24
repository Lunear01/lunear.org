## lunear.org

A single site for the card games my friends and I play. Most online versions carry ads, force
account signup, break on mobile, or just look bad. This is a free alternative that stays up so
we can play a hand from wherever we are.

Built for fun, not for money. Don't use it as a gambling site.

### Games

- **Dou Dizhu** (Fight the Landlord) — `games/doudizhu`
- **Liar's Bar** — `games/liarsbar`
- **Poker** — `games/poker`
- **Blackjack** — `games/blackjack`
- **Chu Dai D** (Hong Kong Big Two) — `games/chudaidi`
- **UNO** — `games/uno`, with its own 108-card deck model
- **Pescalo** (Go Fish) — `games/pescalo`

Each game package holds pure game logic and rules, with no server or UI code, so it can be tested
and reused on its own.

### Architecture

- `worker/` — Cloudflare Worker (Hono) serving the API. Each active game table is a Durable
  Object, one per game type (`GameTableDO`, `LiarsBarTableDO`, `PokerTableDO`,
  `BlackjackTableDO`, `ChuDaiDTableDO`, `UnoTableDO`, `PescaloTableDO`), plus a `LobbyDO`
  for matchmaking. A D1 database holds persistent data (accounts, history).
- `web/` — React + Vite frontend, served as static assets by the same Worker.
- `games/*` — game logic packages, imported by both `worker` and `web`.
- `worker/src/shop` — shop catalog (card-back skins, prices), shared with `web`. Skin rendering
  lives in `web/src/skins`: one shared WebGL canvas feeds every animated card back.

### Setup

```
npm install
npm run dev        # worker + web together, with live reload
```

### Common commands

```
npm run build       # build web, typecheck worker
npm run typecheck   # typecheck all workspaces
npm test            # run all workspace test suites
```

Deploy steps live in `docs/deploy.md`.
