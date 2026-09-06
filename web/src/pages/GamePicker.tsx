import { Link } from "react-router-dom";

// v1 has exactly one game (games/doudizhu). When the registry grows, this
// tile list should be driven by the registry rather than hardcoded — out of
// scope for S8a, which only wires the doudizhu tile through to its lobby.
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
      </div>
    </div>
  );
}
