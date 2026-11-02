# Changelog

All notable changes to Arc Zero. Releases are deployed from `release/YY.MM.XX` branches;
the newest is at the top.

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
- Water Sort and Brick Blast keep their 3 free hints a day for now; coins come to them later.

### Changed
- Water Sort and Brick Blast: levels 1–3 are now a gentle warm-up.
- Brick Blast is much harder: level 10 now plays like the old level 70, and the curve keeps
  climbing to level 100 (up to 41 rows of 140–150 HP blocks).

### Added
- Install the app: an **Install** button on Android and desktop browsers, and a short
  "Add to Home Screen" guide on iPhone and iPad.

### Upgrade notes
- Database migration `0002` adds the wallet, the coin ledger and assist-free streaks.
  The release workflow runs migrations automatically.
- Regenerate levels (the release workflow does this): the levels file now includes MetroJam.
