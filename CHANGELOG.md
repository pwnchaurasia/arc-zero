# Changelog

All notable changes to Arc Zero. Releases are deployed from `release/YY.MM.XX` branches;
the newest is at the top.

## Unreleased

### Brick Blast
- While you aim, the block the ball will hit first blinks. When the shot grazes the corner
  between two blocks, it shows the one the ball really takes (the engine works it out
  with the same rule as the real shot).
- Aiming on Android: lifting your finger no longer nudges the shot. On release the game
  fires the aim from just before the lift (about 0.1 s earlier); a bigger last-moment
  change is still treated as a deliberate adjustment.
- Three new power-ups from level 11, replacing some of the usual ones (same number per
  level): **DMG** (orange) — balls that touch it hit for double damage until they land;
  **Pierce** (teal ➤) — balls pass through the next 2 blocks, damaging each; **TNT** —
  the first ball to touch it blasts the 8 cells around it for 30 HP. Powered balls glow
  in the power-up's colour.
- Power-ups are no longer sealed inside blocks: one with blocks on every side is moved
  to the nearest open cell in its row (or the row next to it). About 600 moved; ~160
  have no open cell nearby and stay.
- Blocks and starting balls are unchanged on every level; only power-ups changed. Levels
  60, 71, 87 and 90 keep their old power-ups (the solver bot could not finish them with
  the new placement, so they stay as they were).

## Unreleased (planned as 26.11.01)

### New game: MetroJam
- Drive cars out of a jam into parking bays; commuters board cars of their colour.
- Realistic vehicles: the driver takes a seat, so a 2-seater carries 1 passenger,
  a 5-seater 4, and a 50-seat bus 49. Bigger vehicles take up more of the lot (1 to 4 cells).
- 100 levels. Levels 1–3 are a warm-up that still needs thought. Level 5 is as hard as an
  ordinary puzzle game's late levels, and it keeps climbing to level 100 (the last ten
  levels have only three bays).
  Only the front of the queue is visible (10 people early on, down to 6); the rest wait
  as "?" in the loop.
- Commuters wait in a loop at the stop and stream to the cars; cars drive out of the lot,
  round the road and into the bays; full cars pull away. The win screen waits until the
  last car has left.
- Every level is proven winnable without assists before it ships.
- No undo. When you're stuck, replay the level for free or use coins on an assist.
- Every move is replayed on the server; wins that don't replay are rejected.
- Playable without a mouse or touch: each car is also a keyboard and screen-reader button.

### New game: Dead Bridge Assault
- Hold the bridge: your gunner fires on its own; drag (or move the mouse, or use the arrow
  keys) to steer the stream while the horde pours down in three waves and a boss.
- Shoot open gold cages for weapons and units that last 20–25 seconds: Shotgun,
  Minigun, Flamethrower (sets zombies burning), Rocket launcher, Laser rifle, left and
  right turrets, a Tank and a Combat mech; plus instant Repair and a 10-second Barricade.
  A bar under the score shows the time each one has left.
- New guns switch on at once. Turrets, the tank, the mech and the barricade wait in a
  ready slot: tap **Deploy** (or press Space) when the horde gets close; the clock starts
  then. The slot holds one unit; a new one sends the waiting one in, and a unit left
  waiting goes in on its own after 15 seconds.
- Break glowing crates for assists before they fade (8 seconds).
- Seven assists: Airstrike, Freeze, Drone swarm, Orbital lance, Napalm, Rocket barrage and
  a rare Nuke. Earn them from cages and crates or buy them with coins mid-level (the game
  pauses while you decide).
- 100 levels. Levels 1–3 are a warm-up of about 90 seconds. From level 4 the horde is
  much bigger (160–240 zombies), levels run from about 2½ minutes to 4½, and the boss is
  slow and tough enough to walk well into view. Each level is tuned against a sharp
  computer player and climbs to its limit by level 100.
- The server replays your exact inputs to verify every win: health, kills and assists
  can't be faked, and the level can't be played faster than real time.

### Brick Blast
- From level 5, every level starts with 10 more balls. Layouts are unchanged.
- New power-ups: **Scatter** (a ball shatters into three, flying off in random directions;
  the extras last until they land) and **Boost ×2 / ×3** (your next shot launches two or
  three times the balls). +2 balls is gone; +3 and +5 stay.
- Coin assists between shots: **+15 balls** this shot (60), **Laser** a column you pick (70),
  **Hammer** the lowest row (80).
- On-screen messages: Multi break, Mega break, Electric shock, Scatter, Boost, Last ball
  standing, Good shot, Great shot, Unbelievable, Good use of power, Danger zone.

### Water Sort
- **Hidden colours** from level 4: only each bottle's top colour shows until you uncover it,
  and what you've seen stays visible (even after undo). Hidden colours never reach your
  browser before you uncover them.
- **Taller bottles**: 5 deep from level 4, 6 deep from level 51, up to 9 colours.
- Coin assist: **one more empty bottle** (60, up to two per level).

### Players
- Optional **display name** when you save your progress, changeable in Settings
  (2–20 characters, checked for profanity in English and Hindi/Urdu).

### Coins
- One coin balance shared by every game, kept on the server. Everyone starts with 100.
- Coins come only from the first clear of a level: 5 (levels 1–3), 25 (4–30), 40 (31–70),
  60 (71–100). Replays earn nothing.
- +25 for every 3 first clears in a row without assists.
- Coins spent in a level come off that level's reward (never below 0).
- Every spend asks for confirmation first, showing the price and your balance after.
- MetroJam assists: Extra bay (60), Airlift (80), Shuffle (40).
- Coins earned before saving your progress move to your account when you save.
- New **Coins** page explaining the rules, linked from the header on every screen.
- Water Sort and Brick Blast: first clears pay coins too; 3 free hints a day, then a hint
  costs 20 coins.

### Changed
- Water Sort and Brick Blast: levels 1–3 are now a gentle warm-up.
- Brick Blast is much harder: level 10 now plays like the old level 70, and the curve keeps
  climbing to level 100 (up to 41 rows of 140–150 HP blocks).

### Added
- Install the app: an **Install** button on Android and desktop browsers, and a short
  "Add to Home Screen" guide on iPhone and iPad.

### For developers
- Levels are now one file per game (`levels/<game>.json`); `make levels GAME=brick-blast`
  regenerates just one game. In production each is a Docker secret.
- First-party analytics in the `play_events` table (counts only; a keyed hash instead of
  player ids). Example queries in DEVELOPMENT.md.

### Upgrade notes
- Database migrations `0002` (wallet, coin ledger, assist-free streaks) and `0003`
  (display names, play events).
  The release workflow runs migrations automatically.
- Regenerate levels (the release workflow does this): the level files now include MetroJam,
  and the generator writes a folder of per-game files instead of one `levels.json`.
