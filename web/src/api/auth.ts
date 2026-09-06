import { apiGet, apiPost } from "./client";

export interface User {
  id: string;
  username: string;
  credits: number;
  is_admin: boolean;
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

export function logout(): Promise<{ ok: boolean }> {
  return apiPost<{ ok: boolean }>("/api/auth/logout");
}
