import { createContext, use, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { ApiError, api } from "../api/client";
import type { Me } from "../api/types";

interface Session {
  me: Me | null;
  error: string | null;
  refresh: () => Promise<void>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api.me());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Could not reach the server.");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const value = useMemo(() => ({ me, error, refresh }), [me, error, refresh]);
  return <SessionContext value={value}>{children}</SessionContext>;
}

export function useSession(): Session {
  const s = use(SessionContext);
  if (!s) throw new Error("useSession outside SessionProvider");
  return s;
}
