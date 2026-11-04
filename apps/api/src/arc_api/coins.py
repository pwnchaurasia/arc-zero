"""Coins: earned only from server-verified first clears, spent only on assists.

Players: a wallet row plus a ledger row for every change (Postgres). A partial
unique index allows one `clear` row per level, so replays can never pay twice.

Guests: a Redis hash per guest id. Coins can't live in the signed guest ticket:
tickets can be replayed, so an old ticket would bring spent coins back. The
hash moves into a wallet when the guest registers.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

from sqlalchemy import select, text, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from arc_api.db import CoinLedger, GameProgress, Wallet
from arc_api.errors import ApiError
from arc_api.levels import GameId
from arc_api.principal import Principal
from arc_api.state import AppState

START_BALANCE: Final = 100
STREAK_LENGTH: Final = 3
STREAK_BONUS: Final = 25
# (last level of the band, coins for a first clear). Easy intro levels pay little.
REWARD_BANDS: Final = ((3, 5), (30, 25), (70, 40), (100, 60))
# Assist prices per game. Every spend is confirmed by the player first.
PRICES: Final[dict[str, dict[str, int]]] = {
    "metro-jam": {"extra_bay": 60, "airlift": 80, "shuffle": 40},
    "brick-blast": {"bonus_balls": 60, "laser": 70, "hammer": 80},
    "water-sort": {"extra_bottle": 60},
    "gridsnap": {"reshuffle": 40, "bomb": 60},
    "traceout": {"continue": 20, "hint": 30},
    "dead-bridge": {
        "airstrike": 60,
        "freeze": 50,
        "drones": 70,
        "lance": 60,
        "napalm": 50,
        "barrage": 80,
        "nuke": 150,
    },
}
# A hint after the free daily ones (Water Sort, Brick Blast).
HINT_PRICE: Final = 20
# GridSnap has no levels: a run pays at score milestones, (score, coins), when it ends.
MILESTONES: Final = ((1_000, 5), (2_500, 5), (5_000, 10), (10_000, 10))
# Most milestone coins one player or guest can earn per UTC day.
MILESTONE_DAILY_CAP: Final = 30

_SPEND = """
redis.call('hsetnx', KEYS[1], 'bal', ARGV[2])
local price = tonumber(ARGV[1])
if tonumber(redis.call('hget', KEYS[1], 'bal')) < price then return -1 end
local left = redis.call('hincrby', KEYS[1], 'bal', -price)
redis.call('expire', KEYS[1], ARGV[3])
return left
"""

# Returns {first_clear, bonus_paid, balance}.
_AWARD = """
local key = KEYS[1]
redis.call('hsetnx', key, 'bal', ARGV[7])
if redis.call('hsetnx', key, ARGV[1], ARGV[2]) == 0 then
  return {0, 0, tonumber(redis.call('hget', key, 'bal'))}
end
local streak = 0
if ARGV[6] == '0' then streak = (tonumber(redis.call('hget', key, ARGV[3])) or 0) + 1 end
local bonus = 0
if streak >= tonumber(ARGV[4]) then
  streak = 0
  bonus = tonumber(ARGV[5])
end
redis.call('hset', key, ARGV[3], streak)
local bal = redis.call('hincrby', key, 'bal', tonumber(ARGV[2]) + bonus)
redis.call('expire', key, ARGV[8])
return {1, bonus, bal}
"""


# Pays up to ARGV[1] of today's remaining allowance (ARGV[2]); returns what was allowed.
_ALLOW = """
local used = tonumber(redis.call('get', KEYS[1]) or '0')
local allowed = math.max(0, math.min(tonumber(ARGV[1]), tonumber(ARGV[2]) - used))
if allowed > 0 then
  redis.call('incrby', KEYS[1], allowed)
  redis.call('expire', KEYS[1], 172800)
end
return allowed
"""

# Credits a guest: returns the new balance.
_CREDIT_GUEST = """
redis.call('hsetnx', KEYS[1], 'bal', ARGV[2])
local bal = redis.call('hincrby', KEYS[1], 'bal', tonumber(ARGV[1]))
redis.call('expire', KEYS[1], ARGV[3])
return bal
"""


def milestone_coins(score: int) -> int:
    return sum(coins for at, coins in MILESTONES if score >= at)


@dataclass(slots=True)
class MilestoneOutcome:
    earned: int
    balance: int


async def award_milestones(
    db: AsyncSession, state: AppState, who: Principal, game: str, score: int, day: str
) -> MilestoneOutcome:
    """Pays a finished run's milestones, within the daily cap. Players: the caller commits."""
    allowed = int(
        await state.redis.eval(
            _ALLOW,
            1,
            f"coins:milestones:{who.owner}:{day}",
            milestone_coins(score),
            MILESTONE_DAILY_CAP,
        )
    )
    if who.player_id is None:
        bal = await state.redis.eval(
            _CREDIT_GUEST, 1, _guest_key(who), allowed, START_BALANCE, _guest_ttl(state)
        )
        return MilestoneOutcome(earned=allowed, balance=int(bal))
    await _ensure_wallet(db, who.player_id)
    if allowed == 0:
        current = await db.scalar(select(Wallet.balance).where(Wallet.player_id == who.player_id))
        return MilestoneOutcome(earned=0, balance=int(current or 0))
    bal = await _credit(db, who.player_id, allowed)
    db.add(
        CoinLedger(
            player_id=who.player_id,
            delta=allowed,
            balance_after=bal,
            reason="milestone",
            game_id=game,
            detail=f"score:{score}",
        )
    )
    await db.flush()
    return MilestoneOutcome(earned=allowed, balance=bal)


def clear_reward(level: int) -> int:
    for last, coins in REWARD_BANDS:
        if level <= last:
            return coins
    return REWARD_BANDS[-1][1]


@dataclass(slots=True)
class ClearOutcome:
    first_clear: bool
    earned: int
    streak_bonus: int
    balance: int


def _guest_key(who: Principal) -> str:
    assert who.guest is not None
    return f"gcoins:{who.guest.gid}"


def _guest_ttl(state: AppState) -> int:
    return state.settings.guest_ticket_ttl_days * 86400


async def _ensure_wallet(db: AsyncSession, player_id: object) -> None:
    """Players created before coins existed get their starting balance on first use."""
    created = await db.scalar(
        insert(Wallet)
        .values(player_id=player_id, balance=START_BALANCE)
        .on_conflict_do_nothing(index_elements=[Wallet.player_id])
        .returning(Wallet.player_id)
    )
    if created is not None:
        db.add(
            CoinLedger(
                player_id=player_id,
                delta=START_BALANCE,
                balance_after=START_BALANCE,
                reason="welcome",
            )
        )
        await db.flush()


async def balance(db: AsyncSession, state: AppState, who: Principal) -> int:
    if who.player_id is not None:
        stored = await db.scalar(select(Wallet.balance).where(Wallet.player_id == who.player_id))
        return START_BALANCE if stored is None else int(stored)
    raw = await state.redis.hget(_guest_key(who), "bal")
    return START_BALANCE if raw is None else int(raw)


async def spend(
    db: AsyncSession,
    state: AppState,
    who: Principal,
    price: int,
    game: str,
    level: int | None,
    detail: str,
) -> int:
    """Takes `price` coins atomically. Returns the balance left."""
    broke = ApiError(402, "not_enough_coins", "You don't have enough coins for that.")
    if who.player_id is not None:
        await _ensure_wallet(db, who.player_id)
        left = await db.scalar(
            update(Wallet)
            .where(Wallet.player_id == who.player_id, Wallet.balance >= price)
            .values(balance=Wallet.balance - price)
            .returning(Wallet.balance)
        )
        if left is None:
            await db.rollback()
            raise broke
        db.add(
            CoinLedger(
                player_id=who.player_id,
                delta=-price,
                balance_after=left,
                reason="assist",
                game_id=game,
                level=level,
                detail=detail,
            )
        )
        await db.commit()
        return int(left)

    left = int(
        await state.redis.eval(_SPEND, 1, _guest_key(who), price, START_BALANCE, _guest_ttl(state))
    )
    if left < 0:
        raise broke
    return left


async def award_clear(
    db: AsyncSession,
    state: AppState,
    who: Principal,
    game: GameId,
    level: int,
    spent: int,
    assisted: bool,
) -> ClearOutcome:
    """Pays a first clear: the level's reward minus coins spent in that attempt
    (never below 0), plus the streak bonus. Replays pay nothing.

    For players the caller commits, so the payout and the win land together.
    """
    reward = max(clear_reward(level) - spent, 0)
    if who.player_id is not None:
        return await _award_player(db, who, game, level, reward, assisted)

    first, bonus, bal = await state.redis.eval(
        _AWARD,
        1,
        _guest_key(who),
        f"r:{game}:{level}",
        reward,
        f"s:{game}",
        STREAK_LENGTH,
        STREAK_BONUS,
        int(assisted),
        START_BALANCE,
        _guest_ttl(state),
    )
    first_clear = bool(int(first))
    return ClearOutcome(
        first_clear=first_clear,
        earned=reward if first_clear else 0,
        streak_bonus=int(bonus),
        balance=int(bal),
    )


async def _award_player(
    db: AsyncSession, who: Principal, game: GameId, level: int, reward: int, assisted: bool
) -> ClearOutcome:
    player_id = who.player_id
    await _ensure_wallet(db, player_id)
    entry = await db.scalar(
        insert(CoinLedger)
        .values(
            player_id=player_id,
            delta=reward,
            balance_after=0,
            reason="clear",
            game_id=game,
            level=level,
        )
        .on_conflict_do_nothing(
            index_elements=[CoinLedger.player_id, CoinLedger.game_id, CoinLedger.level],
            index_where=text("reason = 'clear'"),
        )
        .returning(CoinLedger.id)
    )
    if entry is None:
        current = await db.scalar(select(Wallet.balance).where(Wallet.player_id == player_id))
        return ClearOutcome(first_clear=False, earned=0, streak_bonus=0, balance=int(current or 0))

    bal = await _credit(db, player_id, reward)
    await db.execute(update(CoinLedger).where(CoinLedger.id == entry).values(balance_after=bal))

    stored = await db.scalar(
        select(GameProgress.streak)
        .where(GameProgress.player_id == player_id, GameProgress.game_id == game)
        .with_for_update()
    )
    streak = 0 if assisted else int(stored or 0) + 1
    bonus = 0
    if streak >= STREAK_LENGTH:
        streak, bonus = 0, STREAK_BONUS
        bal = await _credit(db, player_id, bonus)
        db.add(
            CoinLedger(
                player_id=player_id,
                delta=bonus,
                balance_after=bal,
                reason="streak",
                game_id=game,
                level=level,
            )
        )
    progress = insert(GameProgress).values(
        player_id=player_id, game_id=game, unlocked_level=1, streak=streak
    )
    await db.execute(
        progress.on_conflict_do_update(
            index_elements=[GameProgress.player_id, GameProgress.game_id],
            set_={"streak": progress.excluded.streak},
        )
    )
    await db.flush()
    return ClearOutcome(first_clear=True, earned=reward, streak_bonus=bonus, balance=bal)


async def _credit(db: AsyncSession, player_id: object, amount: int) -> int:
    bal = await db.scalar(
        update(Wallet)
        .where(Wallet.player_id == player_id)
        .values(balance=Wallet.balance + amount)
        .returning(Wallet.balance)
    )
    return int(bal)  # type: ignore[arg-type]


@dataclass(slots=True)
class GuestCoins:
    balance: int
    # (game, level) → coins paid for that first clear.
    clears: dict[tuple[str, int], int]
    streaks: dict[str, int]


async def read_guest(state: AppState, gid: str) -> GuestCoins:
    raw = await state.redis.hgetall(f"gcoins:{gid}")
    out = GuestCoins(balance=START_BALANCE, clears={}, streaks={})
    for k, v in raw.items():
        key = k.decode() if isinstance(k, bytes) else k
        value = int(v)
        if key == "bal":
            out.balance = value
        elif key.startswith("r:"):
            _, game, level = key.split(":", 2)
            out.clears[(game, int(level))] = value
        elif key.startswith("s:"):
            out.streaks[key[2:]] = value
    return out


def open_wallet_from_guest(db: AsyncSession, player_id: object, guest: GuestCoins) -> None:
    """Creates a new player's wallet from their guest coins. The caller commits."""
    db.add(Wallet(player_id=player_id, balance=guest.balance))
    rows: list[tuple[str, int, str | None, int | None]] = [("welcome", START_BALANCE, None, None)]
    rows += [("clear", paid, game, level) for (game, level), paid in sorted(guest.clears.items())]
    # Spends and streak bonuses made as a guest, in one line.
    rest = guest.balance - sum(r[1] for r in rows)
    if rest:
        rows.append(("guest_play", rest, None, None))
    running = 0
    for reason, delta, game, level in rows:
        running += delta
        db.add(
            CoinLedger(
                player_id=player_id,
                delta=delta,
                balance_after=running,
                reason=reason,
                game_id=game,
                level=level,
            )
        )


async def forget_guest(state: AppState, gid: str) -> None:
    await state.redis.delete(f"gcoins:{gid}")
