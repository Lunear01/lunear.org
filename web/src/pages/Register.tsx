import { useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { ApiError } from "../api/client";
import { register } from "../api/auth";
import { useAuth } from "../context/AuthContext";

// Mirrors worker/src/auth/validation.ts so obviously-invalid input never
// round-trips to the server; the server remains the source of truth (e.g.
// duplicate-username 409 can only be known there).
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
const MIN_PASSWORD_LENGTH = 8;

function clientError(username: string, password: string, confirm: string): string | null {
  if (!USERNAME_RE.test(username)) {
    return "username must be 3-20 characters: letters, digits, underscore";
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return "password must be at least 8 characters";
  }
  if (password !== confirm) {
    return "passwords do not match";
  }
  return null;
}

export default function Register() {
  const { user, refresh } = useAuth();
  const navigate = useNavigate();

  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (user) return <Navigate to="/" replace />;

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();

    const validationError = clientError(username, password, confirm);
    if (validationError) {
      setError(validationError);
      return;
    }

    setError(null);
    setSubmitting(true);
    try {
      await register(username, password);
      await refresh();
      navigate("/");
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
      } else {
        setError("could not reach the server, try again");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="card auth-card" onSubmit={(e) => void handleSubmit(e)}>
        <h1 className="auth-card__title">Create an account</h1>
        <p className="auth-card__hint">Every new account starts with 5,000 credits.</p>

        <label className="field">
          <span className="field__label">Username</span>
          <input
            className="field__input"
            type="text"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
          />
          <span className="field__hint">3-20 characters: letters, digits, underscore</span>
        </label>

        <label className="field">
          <span className="field__label">Password</span>
          <input
            className="field__input"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="field__hint">At least 8 characters</span>
        </label>

        <label className="field">
          <span className="field__label">Confirm password</span>
          <input
            className="field__input"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </label>

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}

        <button type="submit" className="button button--primary" disabled={submitting}>
          {submitting ? "Creating account…" : "Register"}
        </button>

        <p className="auth-card__switch">
          Already have an account? <Link to="/login">Log in</Link>
        </p>
      </form>
    </div>
  );
}
