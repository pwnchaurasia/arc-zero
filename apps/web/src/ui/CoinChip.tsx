import { useNav } from "../state/nav";
import { useSession } from "../state/session";
import { CoinIcon } from "./icons";

/** Balance plus the link to the coin rules; shown in every header. */
export function CoinChip({ balance }: { balance?: number }) {
  const { me } = useSession();
  const { openCoins } = useNav();
  const coins = balance ?? me?.coins;
  return (
    <button
      type="button"
      onClick={openCoins}
      aria-label={coins === undefined ? "Coins" : `${coins} coins. Coin rules`}
      className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-2xl border border-gold/30 bg-gold/10 px-2.5 font-bold text-gold transition hover:bg-gold/20 active:scale-95"
    >
      <CoinIcon />
      <span className="tabular-nums">{coins ?? "…"}</span>
      <span className="hidden text-xs font-semibold text-gold/80 min-[440px]:inline">Coins</span>
    </button>
  );
}
