import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { ApiError } from "../api/client";
import { fetchMe, guestLogin, logout as apiLogout, type User } from "../api/auth";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  /** Re-fetch /api/auth/me, e.g. after login/register or a credit change. */
  refresh: () => Promise<void>;
  /** POST /api/auth/guest, stash the returned bearer token in memory, load the header. */
  loginAsGuest: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const me = await fetchMe();
      setUser(me);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setUser(null);
      } else {
        // Network/server error: treat as logged-out rather than crashing the
        // shell — the guarded routes will bounce to /login.
        setUser(null);
      }
    }
  }, []);

  useEffect(() => {
    void (async () => {
      await refresh();
      setLoading(false);
    })();
  }, [refresh]);

  const loginAsGuest = useCallback(async () => {
    await guestLogin();
    // Re-fetch via /api/auth/me (now that the guest token is set) rather than
    // trusting guestLogin()'s own response body, matching the login/register
    // convention: the header always reads from this single source of truth.
    await refresh();
  }, [refresh]);

  const logout = useCallback(async () => {
    try {
      await apiLogout();
    } finally {
      setUser(null);
    }
  }, []);

  const value = useMemo(
    () => ({ user, loading, refresh, loginAsGuest, logout }),
    [user, loading, refresh, loginAsGuest, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
