export type GameId = "water-sort" | "brick-blast" | "metro-jam" | "dead-bridge" | "traceout";

export interface GameProgress {
  unlocked_level: number;
  level_count: number;
  stars: Record<string, number>;
  hints_left: number;
}

export interface Me {
  signed_in: boolean;
  /** Display name (signed-in players only). */
  name: string | null;
  /** Local playtest mode only (ARC_DEV_UNLOCK_ALL): every level can be played. */
  all_levels_open: boolean;
  guest_max_level: number;
  registration_required: boolean;
  games: Record<GameId, GameProgress>;
  coins: number;
}

export type Board = number[][];
export type WsMove = [number, number];

export interface WsStart {
  attempt_id: string;
  level: number;
  /** Units each bottle holds on this level (4 to 6). */
  capacity: number;
  /** True when colours under each bottle's top run are hidden until uncovered. */
  hidden: boolean;
  /** Masked on hidden levels: 255 is a colour not seen yet. */
  board: Board;
  three_star_moves: number;
  two_star_moves: number;
  hints_left: number;
  prices: Record<string, number>;
  hint_price: number;
  reward: number;
  coins: number;
}

export interface LevelWin {
  stars: number;
  unlocked_level: number;
  registration_required: boolean;
}

export interface WsComplete extends LevelWin {
  level: number;
  moves: number;
  best_stars: number;
  first_clear: boolean;
  coins_earned: number;
  streak_bonus: number;
  coins: number | null;
}

export interface WsHint {
  move: WsMove | null;
  dead_end: boolean;
  hints_left: number;
  coins: number | null;
}

export type Shape = "square" | "tri_bl" | "tri_br" | "tri_tl" | "tri_tr";
export type PowerKind =
  | "scatter"
  | "boost2"
  | "boost3"
  | "laser_h"
  | "laser_v"
  | "laser_x"
  | "ball_up3"
  | "ball_up5"
  | "plus_balls2"
  | "plus_balls3"
  | "plus_balls5";

export type BbCell =
  | { t: "empty" }
  | { t: "block"; shape: Shape; hp: number }
  | { t: "power"; kind: PowerKind };

export type BbStatus = "playing" | "won" | "lost";

export interface BbState {
  grid: BbCell[][];
  balls: number;
  launch_x: number;
  turn: number;
  status: BbStatus;
  rows_remaining: number;
  closest: number;
  /** Ball multiplier for the next shot (from a boost power-up); absent = 1. */
  boost?: number;
  /** Extra balls for the next shot (paid assist); absent = 0. */
  bonus?: number;
}

export interface BbStart {
  run_id: string;
  level: number;
  state: BbState;
  hints_left: number;
}

export interface BbTurn {
  turn: number;
  hash: string;
  status: BbStatus;
  state: BbState;
  new_row: BbCell[] | null;
  stars: number;
  unlocked_level: number | null;
  registration_required: boolean;
  /** Set on a win. */
  first_clear: boolean | null;
  coins_earned: number;
  streak_bonus: number;
  coins: number | null;
}

export type BbAssist = "bonus_balls" | "laser" | "hammer";

export interface BbHint {
  aim: number;
  hints_left: number;
  coins: number | null;
}

export interface PowChallenge {
  token: string;
  challenge: string;
  difficulty: number;
  expires_at: number;
}

export type MjKind = "microcar" | "hatchback" | "sedan" | "mpv" | "minivan" | "minibus" | "bus";
export type MjDir = "n" | "e" | "s" | "w";
export type MjAssist = "extra_bay" | "airlift" | "shuffle";
/** `[op, vehicle]`: op 0 tap, 1 airlift, 2 shuffle, 3 extra bay. */
export type MjMove = [number, number];

export interface MjVehicle {
  kind: MjKind;
  color: number;
  x: number;
  y: number;
  dir: MjDir;
}

export interface MjLevelData {
  width: number;
  height: number;
  barriers: [number, number][];
  vehicles: MjVehicle[];
  /** The start of the queue; hard levels hide the rest until the queue moves. */
  queue: number[];
  queue_len: number;
  bays: number;
  visible: number;
}

export interface MjStart {
  attempt_id: string;
  level: number;
  data: MjLevelData;
  prices: Record<MjAssist, number>;
  reward: number;
  coins: number;
}

/** Result of buying an assist (MetroJam, Water Sort): balance, assists owned this attempt. */
export interface MjBuy {
  coins: number;
  owned: Partial<Record<string, number>>;
  spent: number;
}

export interface MjComplete extends LevelWin {
  level: number;
  best_stars: number;
  first_clear: boolean;
  coins_earned: number;
  streak_bonus: number;
  coins: number;
}

export interface CoinRules {
  balance: number;
  start_balance: number;
  rewards: { first_level: number; last_level: number; coins: number }[];
  streak_length: number;
  streak_bonus: number;
  /** Assist prices per game (game id → assist → coins). */
  prices: Record<string, Record<string, number>>;
  /** Price of a hint after the 3 free ones each day (Water Sort, Brick Blast). */
  hint_price: number;
}

export type DbAssist = "airstrike" | "freeze" | "drones" | "lance" | "napalm" | "barrage" | "nuke";

export interface DbStart {
  attempt_id: string;
  level: number;
  /** The whole level script (public: the browser simulates what the server replays). */
  script: unknown;
  prices: Record<DbAssist, number>;
  reward: number;
  coins: number;
}

export interface DbComplete extends LevelWin {
  level: number;
  best_stars: number;
  base_hp: number;
  kills: number;
  seconds: number;
  first_clear: boolean;
  coins_earned: number;
  streak_bonus: number;
  coins: number;
}

export interface ToLevelData {
  width: number;
  height: number;
  /** Each line's cells `[x, y]`, tail first; the arrow points out of the last cell. */
  lines: { cells: [number, number][] }[];
  /** The picture the lines form on silhouette levels. */
  theme?: string;
}

/** `[op, line]`: op 0 tap, 1 continue (refill droplets, paid). */
export type ToMove = [number, number];

export interface ToStart {
  attempt_id: string;
  level: number;
  data: ToLevelData;
  prices: { continue: number; hint: number };
  reward: number;
  coins: number;
}

export interface ToComplete extends LevelWin {
  level: number;
  mistakes: number;
  best_stars: number;
  first_clear: boolean;
  coins_earned: number;
  streak_bonus: number;
  coins: number;
}
