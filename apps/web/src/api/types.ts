export type GameId = "water-sort" | "brick-blast";

export interface GameProgress {
  unlocked_level: number;
  level_count: number;
  stars: Record<string, number>;
  hints_left: number;
}

export interface Me {
  signed_in: boolean;
  /** Local playtest mode only (ARC_DEV_UNLOCK_ALL): every level can be played. */
  all_levels_open: boolean;
  guest_max_level: number;
  registration_required: boolean;
  games: Record<GameId, GameProgress>;
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
