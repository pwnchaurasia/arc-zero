import type {
  BbHint,
  BbStart,
  BbAssist,
  BbTurn,
  Board,
  CoinRules,
  DbAssist,
  DbComplete,
  DbStart,
  GameId,
  Me,
  MjAssist,
  MjBuy,
  MjComplete,
  MjMove,
  MjStart,
  ToComplete,
  ToMove,
  ToStart,
  PowChallenge,
  WsComplete,
  WsHint,
  WsMove,
  WsStart,
} from "./types";

/** Error returned by the API (`{ error: { code, message } }`) or a network failure. */
export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: Record<string, unknown>;

  constructor(status: number, code: string, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const TICKET_KEY = "arc.guestTicket";

/**
 * The guest ticket is a server-signed record of guest progress (levels 1-3).
 * Tampering with it only invalidates it, so storing it client-side is safe.
 */
export const guestTicket = {
  get(): string | null {
    try {
      return localStorage.getItem(TICKET_KEY);
    } catch {
      return null;
    }
  },
  set(ticket: string): void {
    try {
      localStorage.setItem(TICKET_KEY, ticket);
    } catch {
      // Private mode: progress lives for this session only.
    }
  },
  clear(): void {
    try {
      localStorage.removeItem(TICKET_KEY);
    } catch {
      // ignore
    }
  },
};

let identity: Promise<void> | null = null;

/**
 * Guests must hold one ticket before any game request. Without this, two
 * requests fired together (StrictMode, deep links) would each create a
 * different guest and the second one's attempt would not belong to the first.
 */
function ensureIdentity(): Promise<void> {
  identity ??= request<unknown>("GET", "/me").then(
    () => undefined,
    () => {
      identity = null;
    },
  );
  return identity;
}

async function request<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
  if (path !== "/me" && !guestTicket.get()) await ensureIdentity();
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const ticket = guestTicket.get();
  if (ticket) headers["X-Guest-Ticket"] = ticket;

  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: "same-origin",
      cache: "no-store",
    });
  } catch {
    throw new ApiError(0, "offline", "You appear to be offline.");
  }
  if (res.status === 204) return undefined as T;

  const data: unknown = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (data as { error?: Record<string, unknown> } | null)?.error ?? {};
    throw new ApiError(
      res.status,
      typeof err.code === "string" ? err.code : "http_error",
      typeof err.message === "string" ? err.message : "Something went wrong.",
      err,
    );
  }
  const ticketOut = (data as { guest_ticket?: unknown } | null)?.guest_ticket;
  if (typeof ticketOut === "string") guestTicket.set(ticketOut);
  return data as T;
}

const game = (id: GameId) => `/games/${id}`;

export const api = {
  me: () => request<Me>("GET", "/me"),

  ws: {
    start: (level: number) => request<WsStart>("POST", `${game("water-sort")}/levels/${level}/start`),
    complete: (level: number, attemptId: string, moves: WsMove[]) =>
      request<WsComplete>("POST", `${game("water-sort")}/levels/${level}/complete`, {
        attempt_id: attemptId,
        moves,
      }),
    hint: (level: number, attemptId: string, moves: WsMove[], pay?: number) =>
      request<WsHint>("POST", `${game("water-sort")}/levels/${level}/hint`, {
        attempt_id: attemptId,
        moves,
        pay: pay ?? null,
      }),
    reveal: (level: number, attemptId: string, moves: WsMove[]) =>
      request<{ board: Board }>("POST", `${game("water-sort")}/levels/${level}/reveal`, {
        attempt_id: attemptId,
        moves,
      }),
    buy: (level: number, attemptId: string, price: number) =>
      request<MjBuy>("POST", `${game("water-sort")}/levels/${level}/assists`, {
        attempt_id: attemptId,
        kind: "extra_bottle",
        price,
      }),
  },

  bb: {
    start: (level: number) => request<BbStart>("POST", `${game("brick-blast")}/levels/${level}/start`),
    turn: (runId: string, turn: number, aim: number) =>
      request<BbTurn>("POST", `${game("brick-blast")}/runs/${runId}/turn`, { turn, aim }),
    hint: (runId: string, pay?: number) =>
      request<BbHint>("POST", `${game("brick-blast")}/runs/${runId}/hint`, { pay: pay ?? null }),
    assist: (runId: string, turn: number, kind: BbAssist, price: number, col = 0) =>
      request<BbTurn>("POST", `${game("brick-blast")}/runs/${runId}/assist`, { turn, kind, col, price }),
  },

  mj: {
    start: (level: number) => request<MjStart>("POST", `${game("metro-jam")}/levels/${level}/start`),
    reveal: (level: number, attemptId: string, moves: MjMove[]) =>
      request<{ queue: number[] }>("POST", `${game("metro-jam")}/levels/${level}/reveal`, {
        attempt_id: attemptId,
        moves,
      }),
    buy: (level: number, attemptId: string, kind: MjAssist, price: number) =>
      request<MjBuy>("POST", `${game("metro-jam")}/levels/${level}/assists`, {
        attempt_id: attemptId,
        kind,
        price,
      }),
    complete: (level: number, attemptId: string, moves: MjMove[]) =>
      request<MjComplete>("POST", `${game("metro-jam")}/levels/${level}/complete`, {
        attempt_id: attemptId,
        moves,
      }),
  },

  db: {
    start: (level: number) => request<DbStart>("POST", `${game("dead-bridge")}/levels/${level}/start`),
    buy: (level: number, attemptId: string, kind: DbAssist, price: number) =>
      request<MjBuy>("POST", `${game("dead-bridge")}/levels/${level}/assists`, {
        attempt_id: attemptId,
        kind,
        price,
      }),
    complete: (level: number, attemptId: string, log: string) =>
      request<DbComplete>("POST", `${game("dead-bridge")}/levels/${level}/complete`, {
        attempt_id: attemptId,
        log,
      }),
  },

  to: {
    start: (level: number) => request<ToStart>("POST", `${game("traceout")}/levels/${level}/start`),
    buyContinue: (level: number, attemptId: string, price: number) =>
      request<MjBuy>("POST", `${game("traceout")}/levels/${level}/assists`, {
        attempt_id: attemptId,
        kind: "continue",
        price,
      }),
    hint: (level: number, attemptId: string, moves: ToMove[], price: number) =>
      request<{ line: number; coins: number; spent: number }>("POST", `${game("traceout")}/levels/${level}/hint`, {
        attempt_id: attemptId,
        moves,
        price,
      }),
    complete: (level: number, attemptId: string, moves: ToMove[]) =>
      request<ToComplete>("POST", `${game("traceout")}/levels/${level}/complete`, {
        attempt_id: attemptId,
        moves,
      }),
  },

  coins: () => request<CoinRules>("GET", "/coins"),

  powChallenge: (purpose: "register" | "restore") =>
    request<PowChallenge>("POST", "/pow/challenge", { purpose }),
  register: (pow: { token: string; nonce: number }, name?: string) =>
    request<{ recovery_key: string }>("POST", "/auth/register", {
      guest_ticket: guestTicket.get() ?? "",
      pow,
      name: name?.trim() || null,
    }),
  setName: (name: string) => request<{ name: string }>("POST", "/me/name", { name }),
  restore: (recoveryKey: string, pow: { token: string; nonce: number }) =>
    request<undefined>("POST", "/auth/restore", { recovery_key: recoveryKey, pow }),
  newRecoveryKey: () => request<{ recovery_key: string }>("POST", "/auth/recovery-key"),
  logout: async () => {
    await request<undefined>("POST", "/auth/logout");
    identity = null;
  },
};
