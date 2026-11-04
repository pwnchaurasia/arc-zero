"""Who plays what, by name: `python -m arc_api.player_report` inside the API container.

`play_events.who` is a keyed hash, so SQL alone can't join it to `players`. This recomputes
each saved player's hash with the pepper, so the secret never reaches SQL or a shell.
Guests have no account and stay anonymous. Read-only.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass, replace
from datetime import datetime

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession

from arc_api.analytics import who_hash
from arc_api.config import get_settings
from arc_api.db import Player, make_engine, make_sessionmaker

_BY_GAME = text(
    """
    SELECT who, signed_in, game_id,
           count(*) FILTER (WHERE kind = 'start') AS plays,
           count(*) FILTER (WHERE kind = 'clear') AS clears,
           coalesce(sum(seconds), 0)              AS seconds,
           max(at)                                AS last_seen
    FROM play_events
    WHERE game_id IS NOT NULL
    GROUP BY who, signed_in, game_id
    ORDER BY last_seen DESC
    """
)


@dataclass(frozen=True)
class Row:
    name: str
    who: str
    game: str
    plays: int
    clears: int
    seconds: int
    last_seen: datetime


async def by_game(db: AsyncSession, pepper: str) -> list[Row]:
    """One row per player per game, most recently seen first."""
    players = await db.execute(select(Player.id, Player.display_name))
    names = {who_hash(pepper, f"p:{pid}"): name or "(no name)" for pid, name in players}
    return [
        Row(
            name=names.get(r.who, "(deleted)") if r.signed_in else "(guest)",
            who=r.who,
            game=r.game_id,
            plays=r.plays,
            clears=r.clears,
            seconds=r.seconds,
            last_seen=r.last_seen,
        )
        for r in await db.execute(_BY_GAME)
    ]


def totals(rows: list[Row]) -> list[tuple[Row, int]]:
    """Each player's rows added up, with how many different games they played."""
    found: dict[str, tuple[Row, int]] = {}
    for row in rows:
        if row.who not in found:
            found[row.who] = (row, 1)
            continue
        seen, games = found[row.who]
        added = replace(
            seen,
            plays=seen.plays + row.plays,
            clears=seen.clears + row.clears,
            seconds=seen.seconds + row.seconds,
            last_seen=max(seen.last_seen, row.last_seen),
        )
        found[row.who] = (added, games + 1)
    return sorted(found.values(), key=lambda t: t[0].last_seen, reverse=True)


def _table(head: list[str], lines: list[list[str]]) -> str:
    widths = [max(len(line[i]) for line in [head, *lines]) for i in range(len(head))]
    return "\n".join(
        "  ".join(cell.ljust(w) for cell, w in zip(line, widths, strict=True)).rstrip()
        for line in [head, *lines]
    )


def render(rows: list[Row]) -> str:
    def stats(r: Row) -> list[str]:
        when = f"{r.last_seen:%Y-%m-%d %H:%M}"
        return [str(r.plays), str(r.clears), f"{r.seconds / 60:.1f}", when]

    numbers = ["plays", "clears", "minutes", "last seen (UTC)"]
    overall = _table(
        ["player", "who", "games", *numbers],
        [[r.name, r.who, str(games), *stats(r)] for r, games in totals(rows)],
    )
    per_game = _table(
        ["player", "who", "game", *numbers],
        [[r.name, r.who, r.game, *stats(r)] for r in rows],
    )
    return f"Players\n\n{overall}\n\nPlayers by game\n\n{per_game}"


async def _main() -> None:
    settings = get_settings()
    engine = make_engine(settings.database_url.get_secret_value(), 1, 0)
    try:
        async with make_sessionmaker(engine)() as db:
            rows = await by_game(db, settings.recovery_pepper.get_secret_value())
    finally:
        await engine.dispose()
    print(render(rows))


if __name__ == "__main__":
    asyncio.run(_main())
