// Thin fetch wrapper shared by every API module. Talks to the same origin
// (Vite proxies /api to wrangler dev locally; the Worker serves both in prod),
// so cookies ride along automatically — `credentials: "include"` is kept
// explicit anyway since the session cookie is what auth actually rides on.

// Guest session token. Deliberately held ONLY in this module-level variable —
// never localStorage/sessionStorage — so a page reload always loses it. See
// POST /api/auth/guest: guests get no cookie, only this bearer token.
let guestToken: string | null = null;

export function setGuestToken(token: string): void {
  guestToken = token;
}

export function clearGuestToken(): void {
  guestToken = null;
}

export function getGuestToken(): string | null {
  return guestToken;
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

function errorMessage(body: unknown, status: number): string {
  if (body && typeof body === "object" && "error" in body) {
    const { error } = body as { error: unknown };
    if (typeof error === "string" && error.length > 0) return error;
  }
  return `request failed with status ${status}`;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  // Built last (not spread through `...init`) so neither a caller-supplied
  // `init.headers` nor `...init` can accidentally clobber it.
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };
  if (init?.body) headers["Content-Type"] = "application/json";
  if (guestToken) headers["Authorization"] = `Bearer ${guestToken}`;

  const res = await fetch(path, {
    credentials: "include",
    ...init,
    headers,
  });

  const isJson = res.headers.get("content-type")?.includes("application/json");
  const body = isJson ? await res.json().catch(() => null) : null;

  if (!res.ok) {
    throw new ApiError(res.status, errorMessage(body, res.status), body);
  }

  return body as T;
}

export function apiGet<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function apiPost<T>(path: string, data?: unknown): Promise<T> {
  return request<T>(path, {
    method: "POST",
    body: data === undefined ? undefined : JSON.stringify(data),
  });
}

export function apiDelete<T>(path: string): Promise<T> {
  return request<T>(path, { method: "DELETE" });
}
