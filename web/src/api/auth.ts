import { apiGet, apiPost, clearGuestToken, setGuestToken } from "./client";

export interface User {
  id: string;
  username: string;
  credits: number;
  is_admin: boolean;
  is_guest: boolean;
}

interface GuestResponse extends User {
  token: string;
}

export function fetchMe(): Promise<User> {
  return apiGet<User>("/api/auth/me");
}

export function register(username: string, password: string): Promise<User> {
  return apiPost<User>("/api/auth/register", { username, password });
}

export function login(username: string, password: string): Promise<User> {
  return apiPost<User>("/api/auth/login", { username, password });
}

// Stashes the returned token in memory (see api/client.ts) before returning —
// every subsequent request, including the /api/auth/me the caller typically
// fires right after, needs it on the Authorization header since guests get
// no cookie.
export async function guestLogin(): Promise<User> {
  const { token, ...user } = await apiPost<GuestResponse>("/api/auth/guest");
  setGuestToken(token);
  return user;
}

export function logout(): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>("/api/auth/logout").finally(() => clearGuestToken());
}
