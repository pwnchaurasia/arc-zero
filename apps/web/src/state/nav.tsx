import { createContext, use } from "react";

/** App-wide navigation the header needs on every screen. */
export interface Nav {
  openCoins: () => void;
}

export const NavContext = createContext<Nav>({ openCoins: () => undefined });

export function useNav(): Nav {
  return use(NavContext);
}
