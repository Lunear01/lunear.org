import { Link } from "react-router-dom";

// The web app has no live game registry — these two tiles are hardcoded to
// match doudizhu and liarsbar, the only games that exist. When a third game
// lands, revisit whether a registry is worth the abstraction.
export default function GamePicker() {
  return (
    <div className="page">
      <h1 className="page__title">Choose a game</h1>
      <div className="game-grid">
        <Link to="/lobby/doudizhu" className="game-tile">
          <div className="game-tile__art" aria-hidden="true">
            <span className="game-tile__suit game-tile__suit--spade">♠</span>
            <span className="game-tile__suit game-tile__suit--heart">♥</span>
            <span className="game-tile__suit game-tile__suit--club">♣</span>
          </div>
          <div className="game-tile__body">
            <h2 className="game-tile__name">Fight the Landlord</h2>
            <p className="game-tile__meta">3 players &middot; Dou Dizhu</p>
          </div>
        </Link>
        <Link to="/lobby/liarsbar" className="game-tile">
          <div className="game-tile__art game-tile__art--liarsbar" aria-hidden="true">
            <span className="game-tile__cardback" />
            <span className="game-tile__bluff">?</span>
            <span className="game-tile__cardback" />
          </div>
          <div className="game-tile__body">
            <h2 className="game-tile__name">Liar&rsquo;s Bar</h2>
            <p className="game-tile__meta">4 players &middot; Bluffing</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
