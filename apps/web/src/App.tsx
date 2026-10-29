import { lazy, Suspense, useCallback, useEffect, useState } from "react";

import type { GameId } from "./api/types";
import { Home } from "./screens/Home";
import { LevelSelect } from "./screens/LevelSelect";
import { CheckpointModal, RestoreModal, SettingsModal } from "./screens/modals";

const WaterSortScreen = lazy(() =>
  import("./screens/WaterSortScreen").then((m) => ({ default: m.WaterSortScreen })),
);
const BrickBlastScreen = lazy(() =>
  import("./screens/BrickBlastScreen").then((m) => ({ default: m.BrickBlastScreen })),
);

function Loading() {
  return <div className="grid h-full place-items-center text-muted">Loading…</div>;
}

type Route =
  | { name: "home" }
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
  const [modal, setModal] = useState<"settings" | "restore" | "checkpoint" | null>(null);
  const close = useCallback(() => setModal(null), []);
  const openCheckpoint = useCallback(() => setModal("checkpoint"), []);

  // "Next level" replaces the current entry, so Back still returns to the level list.
  const replaceLevel = useCallback(
    (game: GameId, level: number) => replace({ name: "play", game, level }),
    [replace],
  );

  return (
    <>
      {route.name === "home" && (
        <Home
          onOpen={(game) => go({ name: "levels", game })}
          onSettings={() => setModal("settings")}
          onCheckpoint={openCheckpoint}
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
    </>
  );
}
