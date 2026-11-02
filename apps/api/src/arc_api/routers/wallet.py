"""Coin balance and the rules behind it, so the Coins page never drifts from the server."""

from __future__ import annotations

from fastapi import APIRouter

from arc_api import coins
from arc_api.principal import PrincipalDep
from arc_api.routers.common import StrictModel
from arc_api.state import DbDep, StateDep

router = APIRouter(tags=["coins"])


class RewardBand(StrictModel):
    first_level: int
    last_level: int
    coins: int


class CoinsOut(StrictModel):
    balance: int
    start_balance: int
    rewards: list[RewardBand]
    streak_length: int
    streak_bonus: int
    # Assist prices per game, and the price of a hint after the free daily ones.
    prices: dict[str, dict[str, int]]
    hint_price: int


@router.get("/coins")
async def coin_rules(who: PrincipalDep, state: StateDep, db: DbDep) -> CoinsOut:
    bands, first = [], 1
    for last, paid in coins.REWARD_BANDS:
        bands.append(RewardBand(first_level=first, last_level=last, coins=paid))
        first = last + 1
    return CoinsOut(
        balance=await coins.balance(db, state, who),
        start_balance=coins.START_BALANCE,
        rewards=bands,
        streak_length=coins.STREAK_LENGTH,
        streak_bonus=coins.STREAK_BONUS,
        prices=coins.PRICES,
        hint_price=coins.HINT_PRICE,
    )
