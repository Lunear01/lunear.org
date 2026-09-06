import { Link, useNavigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function Header() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const handleLogout = async () => {
    await logout();
    navigate("/login");
  };

  return (
    <header className="app-header">
      <Link to="/" className="app-header__brand">
        Lunear Games
      </Link>
      {user && (
        <div className="app-header__account">
          <span
            className={`app-header__credits ${user.credits < 0 ? "app-header__credits--negative" : ""}`}
          >
            {user.credits.toLocaleString()} credits
          </span>
          <span className="app-header__username">
            {user.username}
            {user.is_guest && <span className="guest-tag">guest</span>}
          </span>
          {user.is_admin && (
            <Link to="/admin" className="button button--ghost">
              Admin Panel
            </Link>
          )}
          <button
            type="button"
            className="button button--ghost"
            onClick={() => void handleLogout()}
          >
            Log out
          </button>
        </div>
      )}
    </header>
  );
}
