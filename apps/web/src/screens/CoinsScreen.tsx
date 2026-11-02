import { useEffect, useState } from "react";

import { ApiError, api } from "../api/client";
import type { CoinRules } from "../api/types";
import { CoinIcon } from "../ui/icons";
import { Button, TopBar } from "../ui/kit";

const GAME_NAMES: Record<string, string> = {
  "metro-jam": "MetroJam",
  "brick-blast": "Brick Blast",
  "water-sort": "Water Sort",
};

const ASSIST_NAMES: Record<string, string> = {
  extra_bay: "Extra bay",
  airlift: "Airlift",
  shuffle: "Shuffle",
  bonus_balls: "+15 balls (this shot)",
  laser: "Laser: clear a column",
  hammer: "Hammer: clear the lowest row",
  extra_bottle: "Extra empty bottle",
};

/** The coin rules, straight from the server so this page can't drift from what it enforces. */
export function CoinsScreen({ onBack }: { onBack: () => void }) {
  const [rules, setRules] = useState<CoinRules | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setError(null);
    api.coins().then(setRules, (e: unknown) => {
      setError(e instanceof ApiError ? e.message : "Could not load the coin rules.");
    });
  };
  useEffect(load, []);

  return (
    <div className="flex h-full flex-col">
      <TopBar title="Coins" onBack={onBack} />
      <main className="mx-auto grid w-full max-w-2xl gap-4 overflow-y-auto px-5 pb-10">
        <section className="flex items-center gap-4 rounded-3xl border border-gold/30 bg-gold/10 p-5">
          <span className="grid size-14 place-items-center rounded-2xl bg-gold/20 text-gold">
            <CoinIcon size={32} />
          </span>
          <div>
            <p className="text-sm text-muted">Your coins</p>
            <p className="text-4xl font-black tabular-nums text-gold">{rules?.balance ?? "…"}</p>
          </div>
        </section>

        {error && (
          <div className="flex items-center justify-between gap-3 rounded-2xl bg-red-500/15 p-4 text-sm text-red-200">
            <span>{error}</span>
            <Button variant="secondary" onClick={load}>
              Retry
            </Button>
          </div>
        )}

        {rules && (
          <>
            <section className="rounded-3xl border border-line bg-panel p-5">
              <h2 className="mb-1 text-lg font-bold">Earning coins</h2>
              <p className="mb-3 text-sm text-muted">
                Coins are hard to get on purpose. You earn them only the first time you clear a level, and every
                clear is checked on our server.
              </p>
              <table className="w-full text-sm">
                <thead className="text-left text-muted">
                  <tr>
                    <th className="py-1 font-medium">First clear of</th>
                    <th className="py-1 text-right font-medium">Coins</th>
                  </tr>
                </thead>
                <tbody>
                  {rules.rewards.map((r) => (
                    <tr key={r.first_level} className="border-t border-line">
                      <td className="py-2">
                        Levels {r.first_level}–{r.last_level}
                        {r.first_level === 1 && <span className="text-muted"> (warm-up)</span>}
                      </td>
                      <td className="py-2 text-right font-bold text-gold">{r.coins}</td>
                    </tr>
                  ))}
                  <tr className="border-t border-line">
                    <td className="py-2">
                      {rules.streak_length} first clears in a row without assists
                    </td>
                    <td className="py-2 text-right font-bold text-gold">+{rules.streak_bonus}</td>
                  </tr>
                </tbody>
              </table>
            </section>

            <section className="rounded-3xl border border-line bg-panel p-5">
              <h2 className="mb-3 text-lg font-bold">The rules</h2>
              <ul className="grid list-disc gap-2 pl-5 text-sm">
                <li>Everyone starts with {rules.start_balance} coins.</li>
                <li>Replaying a level you've already cleared earns nothing.</li>
                <li>
                  Coins you spend in a level come off that level's reward. Spend more than the level pays and the
                  clear pays 0 (never less).
                </li>
                <li>Using any assist breaks your no-assist streak.</li>
                <li>We always ask before spending a coin, and show your balance after.</li>
                <li>
                  Coins you earn before saving your progress move to your account when you save. One balance, shared
                  by every game.
                </li>
                <li>Every level can be won without spending anything. Stuck? Replay the level for free.</li>
              </ul>
            </section>

            <section className="rounded-3xl border border-line bg-panel p-5">
              <h2 className="mb-3 text-lg font-bold">Spending coins</h2>
              {Object.entries(rules.prices).map(([game, prices]) => (
                <div key={game} className="mb-4 last:mb-0">
                  <h3 className="mb-1 text-sm font-semibold text-muted">{GAME_NAMES[game] ?? game}</h3>
                  <ul className="grid gap-2 text-sm">
                    {Object.entries(prices).map(([k, price]) => (
                      <li key={k} className="flex justify-between border-t border-line pt-2 first:border-0 first:pt-0">
                        <span>{ASSIST_NAMES[k] ?? k}</span>
                        <span className="font-bold text-gold">{price} coins</span>
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
              <p className="mt-3 text-xs text-muted">
                Water Sort and Brick Blast: 3 free hints a day, then {rules.hint_price} coins a hint.
              </p>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
