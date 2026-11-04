import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from "react";

import type { GameId } from "./api/types";
import { Home } from "./screens/Home";
import { IosInstallModal } from "./screens/IosInstallModal";
import { LevelSelect } from "./screens/LevelSelect";
import { CheckpointModal, RestoreModal, SettingsModal } from "./screens/modals";
import { NavContext } from "./state/nav";
import { setAtHome } from "./state/updates";

const WaterSortScreen = lazy(() =>
  import("./screens/WaterSortScreen").then((m) => ({ default: m.WaterSortScreen })),
);
const BrickBlastScreen = lazy(() =>
  import("./screens/BrickBlastScreen").then((m) => ({ default: m.BrickBlastScreen })),
);
const MetroJamScreen = lazy(() =>
  import("./screens/MetroJamScreen").then((m) => ({ default: m.MetroJamScreen })),
);
const DeadBridgeScreen = lazy(() =>
  import("./screens/DeadBridgeScreen").then((m) => ({ default: m.DeadBridgeScreen })),
);
const GridSnapScreen = lazy(() =>
  import("./screens/GridSnapScreen").then((m) => ({ default: m.GridSnapScreen })),
);
const CoinsScreen = lazy(() => import("./screens/CoinsScreen").then((m) => ({ default: m.CoinsScreen })));

function Loading() {
  return <div className="grid h-full place-items-center text-muted">Loading…</div>;
}

type Route =
  | { name: "home" }
  | { name: "coins" }
  | { name: "gridsnap" }
  | { name: "levels"; game: GameId }
  | { name: "play"; game: GameId; level: number };

/**
 * Minimal router on the History API, so the phone's back button/gesture
 * navigates inside the app instead of leaving it.
 */
function useRoute() {
  const [route, setRoute] = useState<Route>(() => {
    const s = history.state as Route | null;
    return s && typeof s === "object" && "name" in s ? s : { name: "home" };
  });

  useEffect(() => {
    const onPop = (e: PopStateEvent) => setRoute((e.state as Route | null) ?? { name: "home" });
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  const go = useCallback((r: Route) => {
    history.pushState(r, "");
    setRoute(r);
  }, []);
  const replace = useCallback((r: Route) => {
    history.replaceState(r, "");
    setRoute(r);
  }, []);
  const back = useCallback(() => history.back(), []);
  return { route, go, replace, back };
}

export function App() {
  const { route, go, replace, back } = useRoute();
  // A waiting app update is applied only here, never in the middle of a game.
  useEffect(() => setAtHome(route.name === "home"), [route.name]);
  const [modal, setModal] = useState<"settings" | "restore" | "checkpoint" | "ios-install" | null>(null);
  const close = useCallback(() => setModal(null), []);
  const openCheckpoint = useCallback(() => setModal("checkpoint"), []);

  // "Next level" replaces the current entry, so Back still returns to the level list.
  const replaceLevel = useCallback(
    (game: GameId, level: number) => replace({ name: "play", game, level }),
    [replace],
  );

  // The header's Coins link works from every screen; opening it twice doesn't stack pages.
  const nav = useMemo(
    () => ({ openCoins: () => (history.state as Route | null)?.name !== "coins" && go({ name: "coins" }) }),
    [go],
  );

  return (
    <NavContext value={nav}>
      {route.name === "home" && (
        <Home
          onOpen={(game) => go(game === "gridsnap" ? { name: "gridsnap" } : { name: "levels", game })}
          onSettings={() => setModal("settings")}
          onCheckpoint={openCheckpoint}
          onIosInstall={() => setModal("ios-install")}
        />
      )}
      {route.name === "levels" && (
        <LevelSelect
          game={route.game}
          onBack={back}
          onPlay={(level) => go({ name: "play", game: route.game, level })}
          onCheckpoint={openCheckpoint}
        />
      )}
      <Suspense fallback={<Loading />}>
      {route.name === "coins" && <CoinsScreen onBack={back} />}
      {route.name === "gridsnap" && <GridSnapScreen onBack={back} onCheckpoint={openCheckpoint} />}
      {route.name === "play" && route.game === "dead-bridge" && (
        <DeadBridgeScreen
          key={`db-${route.level}`}
          level={route.level}
          onBack={back}
          onLevel={(level) => replaceLevel("dead-bridge", level)}
          onCheckpoint={openCheckpoint}
        />
      )}
      {route.name === "play" && route.game === "metro-jam" && (
        <MetroJamScreen
          key={`mj-${route.level}`}
          level={route.level}
          onBack={back}
          onLevel={(level) => replaceLevel("metro-jam", level)}
          onCheckpoint={openCheckpoint}
        />
      )}
      {route.name === "play" && route.game === "water-sort" && (
        <WaterSortScreen
          key={`ws-${route.level}`}
          level={route.level}
          onBack={back}
          onLevel={(level) => replaceLevel("water-sort", level)}
          onCheckpoint={openCheckpoint}
        />
      )}
      {route.name === "play" && route.game === "brick-blast" && (
        <BrickBlastScreen
          key={`bb-${route.level}`}
          level={route.level}
          onBack={back}
          onLevel={(level) => replaceLevel("brick-blast", level)}
          onCheckpoint={openCheckpoint}
        />
      )}
      </Suspense>

      <SettingsModal
        open={modal === "settings"}
        onClose={close}
        onRestore={() => setModal("restore")}
      />
      <RestoreModal open={modal === "restore"} onClose={close} />
      <CheckpointModal open={modal === "checkpoint"} onClose={close} />
      <IosInstallModal open={modal === "ios-install"} onClose={close} />
    </NavContext>
  );
}
