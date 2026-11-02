export type GameId = "water-sort" | "brick-blast" | "metro-jam";

export interface GameProgress {
  unlocked_level: number;
  level_count: number;
  stars: Record<string, number>;
  hints_left: number;
}

export interface Me {
  signed_in: boolean;
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
  board: Board;
  three_star_moves: number;
  two_star_moves: number;
  hints_left: number;
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
}

export interface WsHint {
  move: WsMove | null;
  dead_end: boolean;
  hints_left: number;
}

export type Shape = "square" | "tri_bl" | "tri_br" | "tri_tl" | "tri_tr";
export type PowerKind =
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
}

export interface BbHint {
  aim: number;
  hints_left: number;
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

export interface MjBuy {
  coins: number;
  owned: Partial<Record<MjAssist, number>>;
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
  prices: Record<MjAssist, number>;
}
