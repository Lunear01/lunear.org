import { apiDelete, apiGet, apiPost } from "./client";

export interface AdminUser {
  id: string;
  username: string;
  credits: number;
  is_admin: boolean;
  created_at: string;
}

export interface UserListPage {
  users: AdminUser[];
  limit: number;
  offset: number;
}

export function listUsers(limit: number, offset: number): Promise<UserListPage> {
  return apiGet<UserListPage>(`/api/admin/users?limit=${limit}&offset=${offset}`);
}

export type CreditMode = "adjust" | "set";

export function adjustCredits(
  userId: string,
  amount: number,
  reason: string,
  mode: CreditMode = "adjust",
): Promise<{ id: string; credits: number | null }> {
  return apiPost(`/api/admin/users/${userId}/credits`, { mode, amount, reason });
}

export function deleteUser(userId: string): Promise<{ ok: boolean }> {
  return apiDelete(`/api/admin/users/${userId}`);
}
