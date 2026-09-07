import { Link } from "react-router-dom";

// The web app has no live game registry — these tiles are hardcoded to match
// the four games that exist (doudizhu, liarsbar, poker, blackjack). Each tile
// is bespoke art + copy anyway, so a registry would only abstract the hrefs.
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
        <Link to="/lobby/poker" className="game-tile">
          <div className="game-tile__art game-tile__art--poker" aria-hidden="true">
            <span className="game-tile__chip game-tile__chip--cream" />
            <span className="game-tile__chip game-tile__chip--gold" />
            <span className="game-tile__chip game-tile__chip--danger" />
          </div>
          <div className="game-tile__body">
            <h2 className="game-tile__name">Poker</h2>
            <p className="game-tile__meta">2&ndash;8 players</p>
          </div>
        </Link>
        <Link to="/lobby/blackjack" className="game-tile">
          <div className="game-tile__art game-tile__art--blackjack" aria-hidden="true">
            <span className="game-tile__bjcard">A</span>
            <span className="game-tile__bjcard game-tile__bjcard--red">J</span>
          </div>
          <div className="game-tile__body">
            <h2 className="game-tile__name">Blackjack</h2>
            <p className="game-tile__meta">1&ndash;5 players &middot; vs the house</p>
          </div>
        </Link>
      </div>
    </div>
  );
}
