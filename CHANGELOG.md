# Changelog

All notable changes to Arc Zero. Releases are deployed from `release/YY.MM.XX` branches;
the newest is at the top.

## Unreleased

### Analytics: plays and time by player name
- `make local-players` (or `python -m arc_api.player_report` in the API container) lists
  each saved player's games, plays, clears, minutes and last visit. Guests stay anonymous.
- `play_events` records a `visit` when the app opens, once per person per day, so you can
  see who opened the link but never started a game.

### Local arcade keeps players' data in folders
- The always-on local stack (`make local-up`) now stores Postgres and Redis in
  `infra/local/pgdata` and `infra/local/redisdata` on the host instead of Docker
  volumes, so friends' progress survives rebuilds, `down -v` and Docker prunes.

### TraceOut: much bigger and more tangled from level 5
- Boards grow to 34 × 48 with longer, twistier lines: across levels 5–100 the "clear
  this first" chains are ~60% deeper and there are ~85% more lines than before.
- Pinch to zoom, drag to move around, double-tap the paper to see the whole board again
  (mouse wheel zooms on a computer). Taps register on release, so a drag never taps.

### GridSnap: every level can be cleared
- Level trays always fit somewhere: losing comes from how you play the stones, not
  from unlucky shapes. Each level must be cleared by most of 10 simulated players who
  play differently (not one lucky line), and the 3-star target is their median.

### TraceOut: every level is a picture
- From level 4 the lines are packed into a picture (91–97% of it covered): heart, apple,
  house, ghost, mushroom, fish, bell, cat, cup, diamond, rabbit, tree, paw, butterfly,
  crown, moon, leaf, rocket, star, umbrella, then round again on bigger boards. Bold
  shapes come first; detailed ones once boards are big enough to draw them.
- Boards grow to 25 × 36 so pictures have detail; the paper shows the picture's outline
  faintly, and a clear says what you drew ("You drew a rabbit!"). Levels 1–3 stay plain
  warm-ups.

### Win cards wait for the celebration
- GridSnap, Brick Blast and TraceOut show the result card only after the winning move's
  animation and the celebration have played (about 1.5 s), instead of covering them.
  Brick Blast gets a "Level clear!" banner and bursts.
- GridSnap's "No room!" card also waits (about 1 s) for the last shape to land and its
  lines to clear.

### MetroJam: clearer boarding
- The waiting commuters stand in one straight line (bigger, front on the left) instead
  of a crowded loop. Coloured pills group them: "NEXT 6" over the first group, then the
  following groups; "+N" counts the rest.
- Parked cars show a dot per seat that fills as each commuter walks over and gets in,
  and "Full!" when it leaves.
- The bay that takes the next commuter glows, and so do the cars in the lot of that
  colour, so it's clear which car to send.

### Dead Bridge
- Steering by touch works like a trackpad: slide a finger anywhere and the gunner
  moves by as much (a little more). No need to hold the gunner under your finger.
  The mouse still steers by pointing.
- Zombies are drawn inside the rails; the big ones no longer hang off the bridge.
- Shots that look like hits are hits: bullets hit a zombie anywhere on its drawn body.
- Shotgun pellets and flames past their range still break gold cages (Tank, Turret…)
  and crates, so every power-up can be reached with any gun; they can't hurt zombies
  that far away. Cages and crates flash on every hit.

### Water Sort
- Bottles are glass tubes: round bottom, lip, highlights and a shadow; the liquid has
  depth and a lit surface.
- Pouring: the bottle lifts, glides over in an arc while tipping, a curved stream
  flows with small splashes, the source drains as the target fills, then it settles
  back.

### GridSnap: 100 levels (Endless stays)
- GridSnap opens a level list now, with **Endless** (the game so far, best score and
  leaderboards unchanged) at the top.
- Each level starts with grey **stones** on the board; clear every one of them (fill a row
  or column through it) to win and unlock the next level. Blocks you place don't need
  clearing. Levels 1–3 line the stones up; later levels add more stones, clutter and
  harder shapes.
- No room for any shape: Reshuffle (40) or Bomb (60) as before, with the confirmation,
  or restart the level for free. Coins spent come off that level's first-clear reward.
- Stars by shapes used: 3 at or under the level's target (shown at the top), 2 within
  half again, 1 otherwise. Usual first-clear coins; the server checks every placement
  and decides the win.

### TraceOut
- The droplets at the top now empty when you lose one (the emoji couldn't change colour),
  with a small pop.
- More life: sparkles where a line leaves the board, a red burst and a shudder on a
  blocked tap, "Nice!" / "Great!" / "Brilliant!" / "On fire!" for clean taps in a row,
  and confetti when a level is cleared.

### Analytics
- Clears, losses and endless game ends record how long they took (`play_events.seconds`,
  server clock), so play time per game can be queried. DEVELOPMENT.md has the queries.

### TraceOut: harder, more tangled levels
- Lines are long and winding now (up to 20 cells, several turns each) and packed tightly,
  so they wrap around each other instead of sitting in open space. Boards grow faster,
  up to 16 × 23.
- Across levels 4–100: the "clear this first" chains are ~45% deeper, lines are ~85%
  longer, and only about a quarter of the lines can leave at the start (was 44%).
  Level 1 is still a warm-up; levels 2–3 step up gently.
- Progress and stars on already-cleared levels are kept; the levels themselves change.

### Development
- CI is faster: the browser engine, the server engine and the level generator are each
  built once, in parallel, and the test jobs reuse them instead of compiling Rust again;
  wasm-pack is downloaded prebuilt; e2e plays 10 levels per game (generated in seconds)
  and no longer waits for the lint and unit-test jobs; the 100-level speed check runs its
  three seeds side by side.
- `make local-up` runs an always-on copy of the arcade in Docker on port 5173 for
  friends through ngrok, with its own database; `make dev` moved to port 5174.

### New game: GridSnap
- Drag block shapes onto an 8 × 8 board; full rows and columns clear. Three shapes at a
  time, placed in any order; new ones come when all three are down. No rotating.
- The dragged shape floats above your finger so you can see where it lands; a preview
  shows the spot and the lines it would clear. Keyboard play too (1–3, arrows, Enter).
- Scoring: 1 per block; 100 / 300 / 600 / 1,000 for 1–4 lines at once (more for 5–6);
  clearing on back-to-back moves builds a combo (+150 per step, up to 8 steps).
- Endless, moderately hard: early trays can always be placed, and that help fades as your
  score climbs, with more big shapes. A careful game usually ends in the low thousands.
- No room left? Reshuffle the tray (40 coins) or drop a Bomb on a 3 × 3 area (60), with
  the usual confirmation, or end the game. Up to 3 of each per game.
- Personal best, plus weekly, monthly and all-time leaderboards (display names only;
  registered players; games with bought help count for your best but not the boards).
- Coins at score milestones (1,000 / 2,500 / 5,000 / 10,000 → 5 / 5 / 10 / 10), paid when
  the game ends, up to 30 a day. Leaving mid-game keeps it: you continue next time.
- The server deals every tray and checks every placement; the next shapes never reach
  the browser before they are dealt.

### App updates
- New versions show up without a hard refresh: the page always loads fresh from the
  network (a saved copy is used only offline), the app checks for updates whenever it
  comes back to the front, and switches to the new version on the home screen (never
  mid-level). Installed home-screen apps update the same way; the first time after this
  release, close and reopen the app once.

### New game: TraceOut
- Tap a line to send it off the board along its arrow. If another line is in the way it
  bounces back and you lose one of your 3 droplets. Clear every line to win.
- 100 levels. Levels 1–3 are a warm-up; then the board, the number of lines (up to 50)
  and the "clear this one first" chains grow steadily. Every 5th level forms a picture
  (heart, diamond, circle, hourglass, cross, ring).
- Stars: 3 with no mistakes ("Flawless!"), 2 with one, 1 otherwise.
- Out of droplets: restart for free, or **Continue** (20 coins) to refill them and keep
  the board. **Hint** (30 coins) shows a line that can leave now. Both ask first.
- Coins: the usual first-clear rewards; the server replays every tap to check the win.
- Tap anywhere on a line (not just the arrow). Keyboard and screen readers get one
  button per line.

### For developers
- `levels/traceout.json` is a new level file: the release workflow, `activate.sh` and both
  compose files ship it.

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

### Upgrade notes
- Database migrations `0004` (GridSnap scores) and `0005` (play time). The release
  workflow runs them.
- New level file `gridsnap.json` (GridSnap levels): the release workflow, `activate.sh`
  and both compose files ship it.

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
