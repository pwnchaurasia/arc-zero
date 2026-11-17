"""A parent's view of LogoQuest learning: `python -m arc_api.logo_report NAME [DAYS]`.

Runs inside the API container (`make logo-report NAME=...` locally). Reads the practice
log (`logo_checks`), one row per "Check my code", for the saved players with that name:

- Day by day: minutes practised, Learn levels and Tests passed, checks that failed, hints.
- Every Test passed: tries, time, blocks against par, and flags worth a look.
- Levels tried but not passed yet (where they are stuck).

Flags are reasons to look closer, not proof: `fast` (passed quicker than tapping the
answer in could take), `no_runs` (never pressed Run before checking), `few_taps` (fewer
taps than blocks: not built in the app), and `quick` (under a third of this player's
usual time for a Test in the same chapter).
"""

from __future__ import annotations

import asyncio
import statistics
import sys
from collections import defaultdict
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from arc_api.config import get_settings
from arc_api.db import LogoCheck, Player, make_engine, make_sessionmaker
from arc_api.levels import LqLevel, load

# One sitting longer than this is someone walking away, not practising.
MAX_ATTEMPT_SECONDS = 30 * 60


@dataclass(frozen=True)
class Check:
    at_day: date
    attempt: str
    level: int
    kind: str
    passed: bool
    accuracy: int
    blocks: int
    par: int
    stars: int | None
    seconds: int
    active_seconds: int
    runs: int
    hints: int
    flags: str


def _table(head: list[str], rows: list[list[str]]) -> str:
    if not rows:
        return "  (nothing yet)"
    widths = [max(len(r[i]) for r in [head, *rows]) for i in range(len(head))]
    return "\n".join(
        "  " + "  ".join(c.ljust(w) for c, w in zip(r, widths, strict=True)).rstrip()
        for r in [head, *rows]
    )


def _mmss(seconds: int) -> str:
    return f"{seconds // 60}:{seconds % 60:02d}"


def _title(levels: dict[int, LqLevel], level: int, kind: str) -> str:
    found = levels.get(level)
    if found is None:
        return "?"
    return (found.learn if kind == "learn" else found.test).title


def report(name: str, checks: list[Check], levels: dict[int, LqLevel], days: int) -> str:
    out = [f"LogoQuest: {name}", ""]
    chapter = {n: lv.chapter for n, lv in levels.items()}

    # Time per attempt: its last check, capped; counted on the day it started.
    attempt_day: dict[str, date] = {}
    attempt_secs: dict[str, int] = defaultdict(int)
    for c in checks:
        attempt_day.setdefault(c.attempt, c.at_day)
        attempt_secs[c.attempt] = max(attempt_secs[c.attempt], min(c.seconds, MAX_ATTEMPT_SECONDS))

    first_pass: dict[tuple[int, str], Check] = {}
    for c in checks:
        if c.passed and (c.level, c.kind) not in first_pass:
            first_pass[(c.level, c.kind)] = c

    by_day: dict[date, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for attempt, secs in attempt_secs.items():
        by_day[attempt_day[attempt]]["seconds"] += secs
    for c in checks:
        d = by_day[c.at_day]
        d["checks"] += 1
        d["failed"] += 0 if c.passed else 1
        d["flagged"] += 1 if c.flags else 0
    for (_, kind), c in first_pass.items():
        by_day[c.at_day]["learned" if kind == "learn" else "tests"] += 1
    hints: dict[str, int] = {}
    for c in checks:
        hints[c.attempt] = max(hints.get(c.attempt, 0), c.hints)
    for attempt, n in hints.items():
        by_day[attempt_day[attempt]]["hints"] += n

    recent = sorted(by_day)[-days:]
    out.append(f"Day by day (last {days} days played)")
    out.append(
        _table(
            ["day", "minutes", "learned", "tests passed", "checks", "failed", "hints", "flagged"],
            [
                [
                    str(d),
                    str(round(by_day[d]["seconds"] / 60)),
                    str(by_day[d]["learned"]),
                    str(by_day[d]["tests"]),
                    str(by_day[d]["checks"]),
                    str(by_day[d]["failed"]),
                    str(by_day[d]["hints"]),
                    str(by_day[d]["flagged"]),
                ]
                for d in reversed(recent)
            ],
        )
    )

    # His usual time to pass a Test, per chapter: a pass far quicker is worth a look.
    test_times: dict[int, list[int]] = defaultdict(list)
    for (lv, kind), c in first_pass.items():
        if kind == "test":
            test_times[chapter.get(lv, 0)].append(c.seconds)
    usual = {ch: statistics.median(t) for ch, t in test_times.items() if len(t) >= 3}

    # Checks up to and including the first pass (checks are in time order).
    tries: dict[tuple[int, str], int] = defaultdict(int)
    done: set[tuple[int, str]] = set()
    for c in checks:
        key = (c.level, c.kind)
        if key not in done:
            tries[key] += 1
            if c.passed:
                done.add(key)
    rows = []
    for (lv, kind), c in sorted(first_pass.items(), key=lambda kv: kv[1].at_day, reverse=True):
        if kind != "test":
            continue
        flags = [f for f in c.flags.split(",") if f]
        median = usual.get(chapter.get(lv, 0))
        if median and c.seconds < median / 3:
            flags.append("quick")
        title = _title(levels, lv, kind)
        rows.append(
            [
                str(c.at_day),
                f"{lv} {title}",
                str(tries[(lv, kind)]),
                _mmss(c.seconds),
                str(c.runs),
                f"{c.blocks}/{c.par}",
                "*" * (c.stars or 0),
                str(c.hints),
                ",".join(flags),
            ]
        )
    out += ["", "Tests passed (newest first)"]
    out.append(
        _table(
            ["day", "test", "tries", "time", "runs", "blocks/par", "stars", "hints", "flags"], rows
        )
    )

    stuck: dict[tuple[int, str], list[Check]] = defaultdict(list)
    for c in checks:
        if (c.level, c.kind) not in first_pass:
            stuck[(c.level, c.kind)].append(c)
    out += ["", "Not passed yet (where to help)"]
    out.append(
        _table(
            ["level", "fails", "best accuracy", "last tried"],
            [
                [
                    f"{lv} {kind} ({_title(levels, lv, kind)})",
                    str(len(cs)),
                    f"{max(c.accuracy for c in cs)}%",
                    str(max(c.at_day for c in cs)),
                ]
                for (lv, kind), cs in sorted(stuck.items())
            ],
        )
    )
    return "\n".join(out)


async def load_checks(db: AsyncSession, name: str) -> dict[str, list[Check]]:
    players = (
        await db.execute(
            select(Player.id, Player.display_name).where(Player.display_name.ilike(name))
        )
    ).all()
    out: dict[str, list[Check]] = {}
    for pid, display in players:
        rows = await db.scalars(
            select(LogoCheck).where(LogoCheck.player_id == pid).order_by(LogoCheck.at)
        )
        out[f"{display} ({pid})"] = [
            Check(
                at_day=r.day,
                attempt=r.attempt,
                level=r.level,
                kind=r.kind,
                passed=r.passed,
                accuracy=r.accuracy,
                blocks=r.blocks,
                par=r.par,
                stars=r.stars,
                seconds=r.seconds,
                active_seconds=r.active_seconds,
                runs=r.runs,
                hints=r.hints,
                flags=r.flags,
            )
            for r in rows
        ]
    return out


async def _main(name: str, days: int) -> None:
    settings = get_settings()
    levels = load(settings.levels_path).logoquest
    engine = make_engine(settings.database_url.get_secret_value(), 1, 0)
    try:
        async with make_sessionmaker(engine)() as db:
            found = await load_checks(db, name)
    finally:
        await engine.dispose()
    if not found:
        print(f"No saved player called {name!r}. They need to save their progress with that name.")
        return
    print("\n\n".join(report(who, checks, levels, days) for who, checks in found.items()))


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("usage: python -m arc_api.logo_report NAME [DAYS]")
    asyncio.run(_main(sys.argv[1], int(sys.argv[2]) if len(sys.argv) > 2 else 14))
